/**
 * The note after a night (T-497), end to end through what this repo owns: /admin/events (the page a steward sees),
 * POST /api/portal/events/followups (the click), migration 066's SQL on PGlite (decide_night_followups: the weekly
 * cap, unsubscribes, opt-outs), the opt-out link route, and lib/email.ts's provider seam with the real Resend SDK.
 * Faked only at the network edge: Techne (the staging stand-in, spawned, over a tiny AppView answering no records),
 * Supabase's HTTP layer (PGlite) and Resend's API (edge.mails). Nights and RSVPs are real records in the stand-in.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { NextRequest } from "next/server";
import type { PGlite } from "@electric-sql/pglite";
import type { FakeAuthUser } from "./pglitePostgrest";
import { migration } from "./onchainDb";
import { doorDb, edgeFetch, type Edge } from "./support/oneDoorHarness";

const browser = vi.hoisted(() => ({ jar: new Map<string, string>() as Map<string, string> }));
vi.mock("next/headers", async () => {
  const { cookieStore } = await import("./support/oneDoorHarness");
  return { cookies: async () => cookieStore(browser.jar), headers: async () => new Headers() };
});
vi.mock("next/cache", () => ({ revalidateTag: () => {}, revalidatePath: () => {} }));

import { POST as signinPOST } from "@/app/techne/signin/route";
import { GET as callbackGET } from "@/app/techne/callback/route";
import { POST as followupsPOST } from "@/app/api/portal/events/followups/route";
import { GET as optoutGET, POST as optoutPOST } from "@/app/api/followups/optout/route";
import EventsPage from "@/app/admin/events/page";
import { NightFollowups } from "@/components/portal/NightFollowups";
import type { NightFollowupView } from "@/lib/nightFollowupData";

const HUB = "did:plc:hubfollow";
const STEWARD = { did: "did:plc:stewardfu", handle: "steward-fu.techne.town", name: "RegenHub manager (sample)" };
const ANA = { did: "did:plc:anafu", handle: "ana-fu.techne.town", name: "Ana (sample member, no Techne role)" };
const SAM = { did: "did:plc:samfu", handle: "sam-fu.techne.town", name: "Sam (sample guest)" };
const LEE = { did: "did:plc:leefu", handle: "lee-fu.techne.town", name: "Lee (sample, unsubscribed)" };
const KIM = { did: "did:plc:kimfu", handle: "kim-fu.techne.town", name: "Kim (sample, Techne only)", email: "kim@example.test", emailConfirmed: true };
const JO = { did: "did:plc:jofu", handle: "jo-fu.techne.town", name: "Jo (sample, Techne only, never signed in here)" };
const PEOPLE = [STEWARD, ANA, SAM, LEE, KIM, JO];
const SITE = "https://preview.test";

describe("night follow-ups (stand-in Techne, PGlite, Resend at the edge)", () => {
  let appview: Server;
  let standin: ChildProcess;
  let standinUrl = "";
  let pg: PGlite;
  let edge: Edge;
  const realFetch = globalThis.fetch;
  let n = 0;

  beforeAll(async () => {
    appview = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ records: [] }));
    }).listen(0, "127.0.0.1");
    await new Promise((r) => appview.once("listening", r));
    const state = mkdtempSync(join(tmpdir(), "t497-followups-"));
    writeFileSync(join(state, "people.json"), JSON.stringify(PEOPLE));
    writeFileSync(join(state, "seed.json"), JSON.stringify({ collective: HUB, steward: STEWARD.did, events: {} }));
    const port = 20000 + Math.floor(Math.random() * 20000);
    standin = spawn(
      process.execPath,
      [resolve(__dirname, "../../../scripts/staging/techne-standin.mjs"), "--port", String(port),
        "--appview", `http://127.0.0.1:${(appview.address() as AddressInfo).port}`, "--state", state],
      { stdio: "pipe" },
    );
    standinUrl = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      if (await fetch(`${standinUrl}/signin?redirect=http://x/`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 20_000);

  afterAll(() => {
    standin?.kill();
    appview?.close();
  });

  beforeEach(async () => {
    vi.stubEnv("REGENOS_BASE_URL", standinUrl);
    vi.stubEnv("REGENOS_COLLECTIVE_DID", HUB);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
    vi.stubEnv("TECHNE_SIGNIN_ENABLED", "true");
    vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
    vi.stubEnv("TECHNE_STANDIN_URL", standinUrl);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    vi.stubEnv("RESEND_API_KEY", "test-only");
    vi.stubEnv("EMAIL_FROM", "RegenHub <hello@regenhub.test>");
    vi.stubEnv("NEWSLETTER_UNSUBSCRIBE_SECRET", "test-unsub-secret");
    pg = await doorDb();
    await pg.exec(`
      alter table members add column member_type text not null default 'day_pass', add column show_in_directory boolean;
      create table subscriptions (id serial primary key, member_id integer references members(id), status text not null,
        monthly_cents integer not null, plan_key text);
      create table free_day_claims (id serial primary key, email text not null unique, status text not null);`);
    await pg.exec(await migration("066_night_followups.sql"));
    // Ana: a desk member, page not set up. Sam: a day-pass guest. Lee: unsubscribed from the newsletter. Kim: no
    // member row (Techne only). The steward has no member row at all.
    await pg.query(
      `insert into members (name, email, did, member_type) values
         ('Ana Sample', 'ana@example.test', $1, 'hot_desk'), ('Sam Sample', 'sam@example.test', $2, 'day_pass'),
         ('Lee Sample', 'lee@example.test', $3, 'day_pass')`,
      [ANA.did, SAM.did, LEE.did],
    );
    await pg.query("insert into email_unsubscribes (email, source) values ('lee@example.test', 'link')");
    browser.jar = new Map();
    edge = {
      pg, users: new Map<string, FakeAuthUser>(), authByEmail: new Map(), didDocs: new Map(), webDocs: new Map(),
      mails: [], servers: [], passthrough: (u) => u.hostname === "127.0.0.1",
    };
    vi.stubGlobal("fetch", edgeFetch(edge, realFetch));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await pg.close();
  });

  async function signInAs(did: string) {
    browser.jar = new Map();
    const start = await signinPOST(
      new Request(`${SITE}/techne/signin`, {
        method: "POST",
        headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ next: "/admin/events" }).toString(),
      }),
    );
    const go = new URL(start.headers.get("location")!);
    const page = await (await realFetch(`${standinUrl}/signin?${go.searchParams}`)).text();
    const back = [...page.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")).find((h) => h.includes(encodeURIComponent(did)))!;
    await callbackGET(new NextRequest(back));
  }

  /** A night of RegenHub's that ended `hoursAgo` hours ago (written as the collective), and who RSVP'd going. */
  async function pastNight(name: string, hoursAgo: number, going: { did: string }[]): Promise<string> {
    const rkey = `3mfu${String(++n).padStart(4, "0")}aaaaa`.slice(0, 13);
    const end = Date.now() - hoursAgo * 3600_000;
    const res = await realFetch(`${standinUrl}/xrpc/pub.techne.draft.identity.writeAsCollective`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-standin-did": STEWARD.did, "atproto-proxy": "did:web:techne.test#techne" },
      body: JSON.stringify({
        repo: HUB,
        writes: [{
          $type: "com.atproto.repo.applyWrites#create", collection: "community.lexicon.calendar.event", rkey,
          value: { $type: "community.lexicon.calendar.event", name, startsAt: new Date(end - 2 * 3600_000).toISOString(), endsAt: new Date(end).toISOString(), createdAt: new Date().toISOString() },
        }],
      }),
    });
    expect(res.status).toBe(200);
    const uri = `at://${HUB}/community.lexicon.calendar.event/${rkey}`;
    for (const p of going) {
      const r = await realFetch(`${standinUrl}/xrpc/com.atproto.repo.putRecord`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-standin-did": p.did },
        body: JSON.stringify({
          repo: p.did, collection: "community.lexicon.calendar.rsvp", rkey: `${rkey.slice(0, 9)}rsvp`,
          record: { $type: "community.lexicon.calendar.rsvp", subject: { uri, cid: "bafyx" }, status: "community.lexicon.calendar.rsvp#going", createdAt: new Date().toISOString() },
        }),
      });
      expect(r.status).toBe(200);
    }
    return uri;
  }

  /** The follow-up nights the page hands its component (null if the page shows none). */
  function followupsIn(node: ReactNode): NightFollowupView[] | null {
    if (!isValidElement(node)) return Array.isArray(node) ? (node.map(followupsIn).find(Boolean) ?? null) : null;
    const el = node as ReactElement<{ children?: ReactNode; nights?: NightFollowupView[]; followups?: ReactNode }>;
    if (el.type === NightFollowups) return el.props.nights ?? [];
    return followupsIn(el.props.followups) ?? followupsIn(el.props.children);
  }
  const nightOnPage = async (uri: string) => followupsIn((await EventsPage()) as ReactElement)?.find((x) => x.eventUri === uri) ?? null;

  const click = async (event: string, decision: "send" | "skip" | "retry", keep: string[]) => {
    const res = await followupsPOST(
      new Request(`${SITE}/api/portal/events/followups`, {
        method: "POST",
        headers: { origin: SITE, "content-type": "application/json" },
        body: JSON.stringify({ event, decision, keep }),
      }),
    );
    return { status: res.status, ...((await res.json()) as { ok?: boolean; error?: string; sent?: number; held?: number }) };
  };
  const rows = async () =>
    (await pg.query<{ email: string; variant: string; status: string; held_reason: string | null }>(
      "select email, variant, status, held_reason from night_followups order by email",
    )).rows;

  it("the steward sees who and which note; nothing is sent until Send; then each person gets their note through the seam", async () => {
    const uri = await pastNight("Civic Tech Night", 20, [ANA, SAM, LEE, KIM]);
    await signInAs(STEWARD.did);
    const night = await nightOnPage(uri);
    expect(night?.state).toBe("open");
    expect(night!.send.map((p) => [p.name, p.variant])).toEqual([["Ana Sample", "member"], ["Sam Sample", "guest"]]);
    expect(night!.held.map((p) => [p.name, p.held])).toEqual([["Lee Sample", "unsubscribed"]]);
    expect(night!.noEmail).toBe(1); // Kim: Techne only, and hasn't signed in here since sign-ins carry the email
    expect(night!.previews.guest?.subject).toBe("Thanks for coming to Civic Tech Night");
    expect(night!.previews.member?.html).toContain("/portal/profile");
    // Rendering the page sent nothing and recorded nothing.
    expect(edge.mails).toEqual([]);
    expect(await rows()).toEqual([]);

    const ids = night!.send.map((p) => p.did);
    expect(await click(uri, "send", ids)).toMatchObject({ status: 200, ok: true, sent: 2, held: 0 });
    // Through lib/email.ts sendEmailDetailed → the Resend provider → Resend's API (the edge): one mail each, nobody else.
    expect(edge.mails.map((m) => [m.to, m.subject])).toEqual([
      ["ana@example.test", "Thanks for coming to Civic Tech Night"],
      ["sam@example.test", "Thanks for coming to Civic Tech Night"],
    ]);
    const sam = edge.mails.find((m) => m.to === "sam@example.test")!;
    expect(sam.html).toContain(`${SITE}/membership`);
    expect(sam.html).toContain("/api/newsletter/unsubscribe?email=sam%40example.test");
    expect(sam.html).toContain("/api/followups/optout?email=sam%40example.test");
    expect(edge.mails.find((m) => m.to === "ana@example.test")!.html).not.toContain("/membership");
    // A guest who never had a free day is offered one; a member isn't.
    expect(sam.html).toContain(`<a href="${SITE}/freeday"`);
    expect(sam.html).toContain("Your first day here is free");
    expect(edge.mails.find((m) => m.to === "ana@example.test")!.html).not.toContain("/freeday");
    expect(await rows()).toEqual([
      { email: "ana@example.test", variant: "member", status: "sent", held_reason: null },
      { email: "sam@example.test", variant: "guest", status: "sent", held_reason: null },
    ]);
    const audit = await pg.query<{ action: string; payload: { decision: string; sending: number } }>("select action, payload from admin_actions");
    expect(audit.rows).toEqual([expect.objectContaining({ action: "night_followups_decided", payload: expect.objectContaining({ decision: "send", by_did: STEWARD.did }) })]);

    // Decided once: a second click (another tab) sends nothing more.
    expect(await click(uri, "send", ids)).toMatchObject({ status: 409, ok: false });
    expect(edge.mails).toHaveLength(2);
    expect((await nightOnPage(uri))?.state).toBe("sent");
  });

  it("a Techne-only RSVP becomes reachable once they've signed in here: their confirmed email, the guest note", async () => {
    // Kim signs in to RSVP (any page): the callback reads her email from her PDS and records her (migration 068).
    await signInAs(KIM.did);
    expect((await pg.query("select email, email_confirmed, member_id from techne_people where did = $1", [KIM.did])).rows)
      .toEqual([{ email: "kim@example.test", email_confirmed: true, member_id: null }]);
    // Kim already had a free day (Sam never asked): only Sam's note offers one. A lapsed claim would count as never.
    await pg.query("insert into free_day_claims (email, status) values ('kim@example.test', 'activated'), ('sam@example.test', 'expired')");
    const uri = await pastNight("Civic Tech Night", 20, [SAM, KIM, JO]);
    await signInAs(STEWARD.did);
    const night = (await nightOnPage(uri))!;
    expect(night.send.map((p) => [p.name, p.variant])).toEqual([["@kim-fu.techne.town", "guest"], ["Sam Sample", "guest"]]);
    expect(night.noEmail).toBe(1); // Jo never signed in here: still no email, never guessed
    expect(await click(uri, "send", night.send.map((p) => p.did))).toMatchObject({ status: 200, sent: 2 });
    const kim = edge.mails.find((m) => m.to === "kim@example.test")!;
    expect(kim.subject).toBe("Thanks for coming to Civic Tech Night");
    expect(kim.html).toContain("Hi there,"); // no display name: never "Hi @kim-fu…"
    expect(kim.html).not.toContain("/freeday");
    expect(edge.mails.find((m) => m.to === "sam@example.test")!.html).toContain("/freeday");
    expect(kim.html).toContain("/api/followups/optout?email=kim%40example.test");
    expect((await pg.query("select email, member_id, status from night_followups where email = 'kim@example.test'")).rows)
      .toEqual([{ email: "kim@example.test", member_id: null, status: "sent" }]);
    expect((await nightOnPage(uri))!.outcomes.map((o) => o.name).sort()).toEqual(["@kim-fu.techne.town", "Sam Sample"]);

    // The hold rules are the same for her: unsubscribed → held, never mailed.
    await pg.query("update night_followups set created_at = now() - interval '8 days'");
    await pg.query("insert into email_unsubscribes (email, source) values ('kim@example.test', 'link')");
    const next = await pastNight("420 Happy Hour", 5, [KIM]);
    const held = (await nightOnPage(next))!;
    expect(held.send).toEqual([]);
    expect(held.held.map((p) => [p.name, p.held])).toEqual([["@kim-fu.techne.town", "unsubscribed"]]);
  });

  it("only the people the steward left ticked get a note; Skip sends nothing", async () => {
    const uri = await pastNight("Agents Building Night", 30, [ANA, SAM]);
    await signInAs(STEWARD.did);
    const night = (await nightOnPage(uri))!;
    const sam = night.send.find((p) => p.name === "Sam Sample")!;
    expect(await click(uri, "send", [sam.did])).toMatchObject({ status: 200, sent: 1 });
    expect(edge.mails.map((m) => m.to)).toEqual(["sam@example.test"]);

    const other = await pastNight("420 Happy Hour", 10, [ANA]);
    expect(await click(other, "skip", [])).toMatchObject({ status: 200, ok: true, sent: 0 });
    expect(edge.mails).toHaveLength(1);
    expect((await nightOnPage(other))?.state).toBe("skipped");
  });

  it("one follow-up a week across nights, and the opt-out link holds a person from then on", async () => {
    const tuesday = await pastNight("Agents Building Night", 60, [SAM, ANA]);
    const friday = await pastNight("420 Happy Hour", 12, [SAM, ANA]);
    await signInAs(STEWARD.did);
    const t = (await nightOnPage(tuesday))!;
    // Both nights are open at once: both pages list Sam.
    expect((await nightOnPage(friday))!.send.map((p) => p.name)).toContain("Sam Sample");
    const tuesdayOut = await click(tuesday, "send", t.send.map((p) => p.did));
    expect(tuesdayOut).toMatchObject({ sent: 2 });

    // Friday's page now holds both; and a click with the old ticks is held in SQL, not sent.
    const f = (await nightOnPage(friday))!;
    expect(f.send).toEqual([]);
    expect(f.held.map((p) => p.held)).toEqual(["this_week", "this_week"]);
    expect(await click(friday, "send", t.send.map((p) => p.did))).toMatchObject({ status: 400 });
    const sql = await pg.query<{ status: string; held_reason: string }>(
      `select (r).status, (r).held_reason from decide_night_followups('at://x/e/1', 'X', now(), 'send', 'did:plc:x',
         '[{"member_id": null, "email": "sam@example.test", "variant": "guest"}]'::jsonb) r`,
    );
    expect(sql.rows).toEqual([{ status: "held", held_reason: "this_week" }]);
    expect(edge.mails).toHaveLength(2);

    // Ana follows the "no more notes" link in her mail.
    const link = /href="([^"]*\/api\/followups\/optout[^"]*)"/.exec(edge.mails.find((m) => m.to === "ana@example.test")!.html)![1].replace(/&amp;/g, "&");
    // Opening the link (or a mail scanner opening it) only shows the button; the button's POST opts her out.
    const shown = await optoutGET(new Request(link));
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain("Stop the notes");
    expect((await pg.query("select email from night_followup_optouts")).rows).toEqual([]);
    expect((await optoutPOST(new Request(link.replace(/token=[^&]+/, "token=forged"), { method: "POST" }))).status).toBe(400);
    expect((await optoutPOST(new Request(link, { method: "POST" }))).status).toBe(200);
    expect((await pg.query("select email from night_followup_optouts")).rows).toEqual([{ email: "ana@example.test" }]);
    // Past the week, she stays out; Sam is back.
    await pg.query("update night_followups set created_at = now() - interval '8 days'");
    const later = (await nightOnPage(friday))!;
    expect(later.send.map((p) => p.name)).toEqual(["Sam Sample"]);
    expect(later.held.map((p) => [p.name, p.held])).toEqual([["Ana Sample", "opted_out"]]);
  });

  it("a signed-in member with no Techne role can't send: 403, nothing recorded, nothing mailed", async () => {
    const uri = await pastNight("Civic Tech Night", 8, [SAM]);
    await signInAs(ANA.did);
    expect(followupsIn((await EventsPage()) as ReactElement)).toBeNull(); // the page shows the explainer, not the batches
    expect(await click(uri, "send", [SAM.did])).toMatchObject({ status: 403, ok: false });
    browser.jar = new Map();
    expect(await click(uri, "send", [SAM.did])).toMatchObject({ status: 401, ok: false });
    expect(edge.mails).toEqual([]);
    expect(await rows()).toEqual([]);
    expect((await pg.query("select * from night_followup_batches")).rows).toEqual([]);
  });

  it("a note that didn't go is recorded and shown, and Retry sends it once, under the same key", async () => {
    const uri = await pastNight("Civic Tech Night", 15, [SAM]);
    await signInAs(STEWARD.did);
    const sam = (await nightOnPage(uri))!.send[0];
    vi.stubEnv("RESEND_API_KEY", ""); // the provider is down for the first click
    expect(await click(uri, "send", [sam.did])).toMatchObject({ status: 200, sent: 0, failed: 1 });
    expect(edge.mails).toEqual([]);
    const failed = (await nightOnPage(uri))!;
    expect(failed.outcomes).toEqual([expect.objectContaining({ name: "Sam Sample", status: "failed" })]);
    expect(failed.retryable).toBe(1);

    vi.stubEnv("RESEND_API_KEY", "test-only");
    // Two clicks at once (two tabs): one claims the note, the other finds nothing to send.
    const both = await Promise.all([click(uri, "retry", []), click(uri, "retry", [])]);
    expect(both.map((b) => b.sent).sort()).toEqual([0, 1]);
    expect(edge.mails.map((m) => m.to)).toEqual(["sam@example.test"]);
    const after = (await nightOnPage(uri))!;
    expect(after.outcomes.map((o) => o.status)).toEqual(["sent"]);
    expect(after.retryable).toBe(0);
    // The retry sent the note saved before the first attempt, byte for byte (same key, same message).
    const saved = await pg.query<{ html: string }>("select html from night_followups");
    expect(edge.mails[0].html).toBe(saved.rows[0].html);
    expect(await click(uri, "retry", [])).toMatchObject({ status: 200, sent: 0 });
    expect(edge.mails).toHaveLength(1);
    expect((await pg.query("select action from admin_actions where action = 'night_followups_retried'")).rows.length).toBeGreaterThan(0);

    // A note left at sending (the request died mid-send) may have gone: never sent again, shown as not confirmed.
    await pg.query("update night_followups set status = 'sending', attempts = attempts + 1");
    expect(await click(uri, "retry", [])).toMatchObject({ status: 200, sent: 0 });
    expect(edge.mails).toHaveLength(1);
    const stuck = (await nightOnPage(uri))!;
    expect(stuck.outcomes.map((o) => o.status)).toEqual(["sending"]);
    expect(stuck.retryable).toBe(0);
  });

  it("Retry asks the hold rule again: someone who opted out after a failed send isn't retried", async () => {
    const uri = await pastNight("Civic Tech Night", 14, [SAM]);
    await signInAs(STEWARD.did);
    const sam = (await nightOnPage(uri))!.send[0];
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await click(uri, "send", [sam.did])).toMatchObject({ failed: 1 });
    await pg.query("insert into night_followup_optouts (email) values ('sam@example.test')");
    vi.stubEnv("RESEND_API_KEY", "test-only");
    expect(await click(uri, "retry", [])).toMatchObject({ status: 200, sent: 0 });
    expect(edge.mails).toEqual([]);
    expect((await nightOnPage(uri))!.outcomes).toEqual([expect.objectContaining({ status: "held", held: "opted_out" })]);
  });

  it("a night that hasn't ended, or ended days ago, can't be sent", async () => {
    const old = await pastNight("Agents Building Night", 24 * 4, [SAM]);
    await signInAs(STEWARD.did);
    expect(await nightOnPage(old)).toBeNull();
    expect(await click(old, "send", [SAM.did])).toMatchObject({ status: 409 });
    expect(edge.mails).toEqual([]);
  });
});
