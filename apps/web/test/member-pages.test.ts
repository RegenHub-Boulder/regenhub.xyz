/**
 * Member pages and the member directory (T-482), through the real routes and pages against a real Postgres (PGlite)
 * with every migration applied, 065 included. Faked: only the network edge, Techne (the PLC directory and handle
 * lookups through the staging stand-in's endpoints, the AppView's getProfile and RSVP/event reads) and the
 * Supabase session (which user is signed in).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { makePgDb, type PgDb } from "./pgDb";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { GET as directoryGET } from "@/app/api/members/directory/route";
import { PATCH as profilePATCH } from "@/app/api/portal/profile/route";
import MemberPage from "@/app/members/[slug]/page";
import MembersPage from "@/app/members/page";

const TECHNE = "http://techne.test";
const HUB = "did:plc:hubpages";
const EV = "community.lexicon.calendar.event";
const RSVP = "community.lexicon.calendar.rsvp";
// Fictional people. Handles resolve through the stand-in's endpoints (TECHNE_STAGING_STANDIN).
const PEOPLE: Record<string, string> = {
  "did:plc:anapages": "ana-sample.techne.town",
  "did:plc:benpages": "ben-sample.techne.town",
  "did:plc:deepages": "dee-sample.techne.town",
};
const ANA = "did:plc:anapages";
const USER_ANA = "00000000-0000-4000-8000-0000000000aa";
const USER_BEN = "00000000-0000-4000-8000-0000000000bb";

const day = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();
const nights = [
  { rkey: "3n2pastaaaaa2", name: "Agents Building Night", startsAt: iso(-20) },
  { rkey: "3n2pastbbbbb2", name: "Civic Tech Night", startsAt: iso(-10) },
  { rkey: "3n2nextccccc2", name: "Studio Night", startsAt: iso(+5) },
  { rkey: "3n2oldddddddd", name: "A night long ago", startsAt: iso(-200) },
].map((n) => ({
  uri: `at://${HUB}/${EV}/${n.rkey}`,
  cid: `bafy${n.rkey}`,
  author: HUB,
  collection: EV,
  value: { $type: EV, name: n.name, startsAt: n.startsAt, endsAt: new Date(Date.parse(n.startsAt) + 2 * 3600_000).toISOString() },
}));
// Ana: going to both past nights and the next one; she changed her mind on the first, then back to going.
const rsvp = (rkey: string, night: number, status: string, at: number) => ({
  uri: `at://${ANA}/${RSVP}/${rkey}`,
  cid: `bafyr${rkey}`,
  author: ANA,
  collection: RSVP,
  value: { $type: RSVP, subject: { uri: nights[night].uri, cid: nights[night].cid }, status: `${RSVP}#${status}`, createdAt: iso(at) },
});
// Another calendar's event the hub lists; Ana went, but it isn't a hub night.
const OTHER = "did:plc:othercalendar";
const listedElsewhere = {
  uri: `at://${OTHER}/${EV}/3n2elsewhere2`, cid: "bafyelsewhere", author: OTHER, collection: EV,
  value: { $type: EV, name: "Someone else's meetup", startsAt: iso(-5), endsAt: iso(-4.9) },
};
const listing = {
  uri: `at://${HUB}/pub.techne.draft.event.listing/l1`, cid: "bafylisting", author: HUB, collection: "pub.techne.draft.event.listing",
  value: { event: { uri: listedElsewhere.uri } },
};
const rsvps = [rsvp("r1", 0, "notgoing", -25), rsvp("r2", 0, "going", -21), rsvp("r3", 1, "going", -11), rsvp("r4", 2, "going", -1),
  { ...rsvp("r5", 0, "going", -6), value: { $type: RSVP, subject: { uri: listedElsewhere.uri, cid: listedElsewhere.cid }, status: `${RSVP}#going`, createdAt: iso(-6) } }];

const techneCalls: string[] = [];
function fakeTechne(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  if (url.origin !== TECHNE) return Promise.reject(new Error(`unexpected network call: ${url}`));
  techneCalls.push(url.pathname);
  if (url.pathname.startsWith("/plc/")) {
    const did = decodeURIComponent(url.pathname.slice(5));
    return PEOPLE[did] ? json({ id: did, alsoKnownAs: [`at://${PEOPLE[did]}`] }) : json({}, 404);
  }
  if (url.pathname === "/xrpc/com.atproto.identity.resolveHandle") {
    const did = Object.keys(PEOPLE).find((d) => PEOPLE[d] === url.searchParams.get("handle"));
    return did ? json({ did }) : json({ error: "InvalidRequest" }, 400);
  }
  if (url.pathname === "/xrpc/social.scenius.getProfile") {
    const did = url.searchParams.get("did") ?? "";
    if (!PEOPLE[did]) return json({ error: "NotFound" }, 404);
    return json({
      did, handle: PEOPLE[did], kind: "person", displayName: "From Techne", bio: "Bio from my Techne profile.",
      avatarUrl: `/xrpc/social.scenius.getAvatar?did=${encodeURIComponent(did)}&cid=bafyavatar`, publicContacts: [],
    });
  }
  if (url.pathname === "/xrpc/pub.techne.draft.query.listRecords") {
    const where = JSON.stringify(JSON.parse(url.searchParams.get("query") ?? "{}").where);
    if (where.includes(RSVP)) return json({ records: rsvps.filter((r) => where.includes(r.author)) });
    if (where.includes("event.listing")) return json({ records: [listing] });
    if (where.includes(EV)) return json({ records: nights });
    return json({ records: [] });
  }
  if (url.pathname === "/xrpc/pub.techne.draft.query.getRecords") {
    const uris = url.searchParams.getAll("uris");
    return json({ records: [...nights, listedElsewhere].filter((r) => uris.includes(r.uri)) });
  }
  return json({ error: "NotFound" }, 404);
}

let db: PgDb;

/** Fictional members, one per case. (065's defaults have their own test above; Hal gets the co-op owner's.) */
async function world() {
  db = await makePgDb();
  await db.exec(`
    insert into auth.users (id, email) values ('${USER_ANA}', 'ana@example.test'), ('${USER_BEN}', 'ben@example.test');
    insert into members (id, name, email, member_type, did, is_coop_member, disabled, supabase_user_id, bio, skills, pin_code) values
      (1, 'Ana Sample', 'ana@example.test', 'day_pass', 'did:plc:anapages', false, false, '${USER_ANA}', 'Builds seed libraries.', '{Rust,Gardening}', null),
      (2, 'Ben Sample', 'ben@example.test', 'hub_friend', 'did:plc:benpages', false, false, '${USER_BEN}', 'Not listed.', null, null),
      (3, 'Cy Sample', 'cy@example.test', 'hot_desk', null, false, false, null, null, null, null),
      (4, 'Dee Sample', 'dee@example.test', 'day_pass', 'did:plc:deepages', false, false, null, 'Lapsed.', null, null),
      (5, 'Eve Sample', 'eve@example.test', 'cold_desk', null, false, true, null, 'Disabled.', null, null),
      (6, 'Fay Sample', 'fay@example.test', 'day_pass', null, false, false, null, 'Under 30.', null, null),
      (7, 'Gus Sample', 'gus@example.test', 'cold_desk', null, false, false, null, 'Desk, no Techne link.', null, null),
      (8, 'Hal Sample', 'hal@example.test', 'day_pass', null, true, false, null, 'Co-op owner.', null, null);
    insert into subscriptions (member_id, plan_key, monthly_cents, status, stripe_subscription_id, stripe_customer_id, stripe_price_id)
      select member_id, plan_key, monthly_cents, status, 'sub_' || n, 'cus_' || member_id, 'price_x' from (values
        (1, 1, 'member_basic', 3000, 'active'),
        (2, 4, 'member_2day', 5000, 'canceled'),
        (3, 4, 'member_2day', 5000, 'past_due'),
        (4, 6, 'legacy', 2000, 'active')) v(n, member_id, plan_key, monthly_cents, status);`);
  // Everyone but Ben (never asked) and Cy (said no) opts in; Hal as 065 leaves a co-op owner.
  await db.exec(`update members set show_in_directory = true where id in (1, 4, 5, 6, 7, 8);
    update members set show_in_directory = false where id = 3;
    update members set working_on = 'A seed library app', links = '{https://ana.example.test}', show_rsvps = true where id = 1;`);
  vi.mocked(createServiceClient).mockReturnValue(db as never);
}

function signIn(userId: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    from: db.from,
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId, email: "x@example.test" } : null } }) },
  } as never);
}

const directory = async () => (await (await directoryGET()).json()) as { members: Record<string, unknown>[] };
const page = async (slug: string) => MemberPage({ params: Promise.resolve({ slug }) });
const digestOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "rendered";
  } catch (err) {
    return String((err as { digest?: string }).digest ?? err);
  }
};
const patch = (body: unknown) =>
  profilePATCH(new Request("http://localhost/api/portal/profile", { method: "PATCH", body: JSON.stringify(body) }));
const row = async (id: number) => (await db.sql("select * from members where id = $1", [id]))[0];

beforeEach(async () => {
  vi.clearAllMocks();
  techneCalls.length = 0;
  vi.stubEnv("REGENOS_BASE_URL", TECHNE);
  vi.stubEnv("REGENOS_COLLECTIVE_DID", HUB);
  vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
  vi.stubEnv("TECHNE_STANDIN_URL", TECHNE);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://preview.test");
  vi.stubGlobal("fetch", vi.fn(fakeTechne));
  await world();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.close();
});

describe("migration 065", () => {
  it("keeps co-op owners listed and leaves everyone else unasked", async () => {
    const fresh = await makePgDb({ before: "065" });
    await fresh.exec(`insert into members (id, name, member_type, is_coop_member) values (1, 'Owner', 'day_pass', true), (2, 'Other', 'hot_desk', false);`);
    await fresh.exec(await readFile(new URL("../../../supabase/migrations/065_member_pages.sql", import.meta.url), "utf8"));
    const rows = await fresh.sql<{ id: number; show_in_directory: boolean | null; links: string[]; show_rsvps: boolean }>(
      "select id, show_in_directory, links, show_rsvps from members order by id");
    expect(rows).toEqual([
      { id: 1, show_in_directory: true, links: [], show_rsvps: false },
      { id: 2, show_in_directory: null, links: [], show_rsvps: false },
    ]);
    await fresh.close();
  });
});

describe("who is in the directory", () => {
  it("lists opted-in members in standing (and co-op owners), and nobody else", async () => {
    const names = (await directory()).members.map((m) => m.name);
    // Ana: $30 active, opted in. Gus: desk, opted in. Hal: co-op owner, kept on by 065.
    // Not: Ben (never opted in), Cy (said no), Dee (lapsed: canceled + past due), Eve (disabled), Fay (under $30).
    expect(names).toEqual(["Ana Sample", "Gus Sample", "Hal Sample"]);
  });

  it("answers only public fields: no email, plan, payment, door or account data", async () => {
    const { members } = await directory();
    for (const m of members) {
      expect(Object.keys(m).sort()).toEqual(["bio", "handle", "links", "name", "photoUrl", "skills", "slug", "workingOn"]);
    }
    const text = JSON.stringify(members);
    for (const secret of ["@example.test", "member_basic", "3000", "day_pass", "cold_desk", "did:plc:", "pin", USER_ANA]) {
      expect(text).not.toContain(secret);
    }
    const ana = members.find((m) => m.name === "Ana Sample");
    expect(ana).toMatchObject({
      slug: "ana-sample.techne.town",
      handle: "ana-sample.techne.town",
      workingOn: "A seed library app",
      skills: ["Rust", "Gardening"],
      links: [{ url: "https://ana.example.test", label: "ana.example.test" }],
      // No uploaded photo: her Techne avatar, through the AppView.
      photoUrl: `${TECHNE}/xrpc/social.scenius.getAvatar?did=did%3Aplc%3Aanapages&cid=bafyavatar`,
    });
    expect(members.find((m) => m.name === "Gus Sample")).toMatchObject({ slug: "7", handle: null, photoUrl: null });
  });

  it("drops a member who lapses, keeps their fields, and lists them again when they're back", async () => {
    await db.exec("update subscriptions set status = 'past_due' where member_id = 1");
    expect((await directory()).members.map((m) => m.name)).not.toContain("Ana Sample");
    expect(await digestOf(page("ana-sample.techne.town"))).toContain("404");
    expect(await row(1)).toMatchObject({ working_on: "A seed library app", show_in_directory: true, bio: "Builds seed libraries." });
    await db.exec("update subscriptions set status = 'active' where member_id = 1");
    expect((await directory()).members.map((m) => m.name)).toContain("Ana Sample");
  });

  it("drops a member who is disabled", async () => {
    await db.exec("update members set disabled = true where id = 7");
    expect((await directory()).members.map((m) => m.name)).not.toContain("Gus Sample");
    expect(await digestOf(page("7"))).toContain("404");
  });

  it("renders /members with a card per listed member", async () => {
    const html = renderToStaticMarkup(await MembersPage());
    expect(html).toContain('href="/members/ana-sample.techne.town"');
    expect(html).toContain('href="/members/7"');
    expect(html).not.toContain("Ben Sample");
    expect(html).not.toContain("@example.test");
  });
});

describe("member pages", () => {
  it("shows a listed member's page by Techne handle, with past nights only when they allow it", async () => {
    const html = renderToStaticMarkup((await page("ana-sample.techne.town")) as React.ReactElement);
    expect(html).toContain("Ana Sample");
    expect(html).toContain("A seed library app");
    expect(html).toContain("@ana-sample.techne.town");
    expect(html).toContain("Recent nights at the hub");
    expect(html).toContain("Civic Tech Night");
    expect(html).toContain("Agents Building Night");
    // Never an upcoming night, never one older than 90 days.
    expect(html).not.toContain("Studio Night");
    expect(html).not.toContain("A night long ago");
    // Not a hub night, though the hub lists it and she went.
    expect(html).not.toContain("Someone else");
    expect(html).not.toContain("ana@example.test");

    await db.exec("update members set show_rsvps = false where id = 1");
    techneCalls.length = 0;
    const quiet = renderToStaticMarkup((await page("ana-sample.techne.town")) as React.ReactElement);
    expect(quiet).not.toContain("Recent nights");
    expect(techneCalls).not.toContain("/xrpc/pub.techne.draft.query.listRecords");
  });

  it("shows a member without a Techne link by id, and sends a linked member's id to their handle", async () => {
    const gus = renderToStaticMarkup((await page("7")) as React.ReactElement);
    expect(gus).toContain("Gus Sample");
    expect(await digestOf(page("1"))).toMatch(/NEXT_REDIRECT;.*\/members\/ana-sample\.techne\.town;307/);
  });

  it.each([
    ["not opted in (by handle)", "ben-sample.techne.town"],
    ["not opted in (by id)", "2"],
    ["said no", "3"],
    ["lapsed", "dee-sample.techne.town"],
    ["lapsed (by id)", "4"],
    ["disabled", "5"],
    ["under $30", "6"],
    ["no such member", "999"],
    ["an unknown handle", "nobody.techne.town"],
    ["junk", "../../etc"],
  ])("404s for someone %s", async (_label, slug) => {
    expect(await digestOf(page(slug))).toContain("404");
  });
});

describe("editing your own page", () => {
  it("writes the signed-in member's own row, and only the page fields it allows", async () => {
    signIn(USER_ANA);
    const res = await patch({
      working_on: "  Mapping Boulder's creeks  ",
      links: "creeks.example.test\nhttps://github.com/ana-sample",
      show_in_directory: false,
      show_rsvps: false,
      // None of these may be written through this route.
      id: 2, supabase_user_id: USER_BEN, is_admin: true, member_type: "cold_desk", email: "evil@example.test", did: "did:plc:benpages",
    });
    expect(res.status).toBe(200);
    expect(await row(1)).toMatchObject({
      working_on: "Mapping Boulder's creeks",
      links: ["https://creeks.example.test/", "https://github.com/ana-sample"],
      show_in_directory: false,
      show_rsvps: false,
      is_admin: false,
      member_type: "day_pass",
      email: "ana@example.test",
      did: ANA,
      supabase_user_id: USER_ANA,
    });
    expect(await row(2)).toMatchObject({ working_on: null, links: [], show_in_directory: null, bio: "Not listed." });
    expect((await directory()).members.map((m) => m.name)).not.toContain("Ana Sample");
  });

  it("keeps the working-on line to one line", async () => {
    signIn(USER_ANA);
    expect((await patch({ working_on: "Seeds\n\n  and   soil" })).status).toBe(200);
    expect((await row(1)).working_on).toBe("Seeds and soil");
  });

  it("refuses a signed-out caller and bad page fields", async () => {
    signIn(null);
    expect((await patch({ working_on: "x" })).status).toBe(401);
    signIn(USER_ANA);
    expect((await patch({ working_on: "x".repeat(141) })).status).toBe(400);
    expect((await patch({ links: ["javascript:alert(1)"] })).status).toBe(400);
    expect((await patch({ links: ["a.example", "b.example", "c.example", "d.example", "e.example", "f.example"] })).status).toBe(400);
    expect((await patch({ show_in_directory: "yes" })).status).toBe(400);
    expect(await row(1)).toMatchObject({ working_on: "A seed library app", show_in_directory: true });
  });
});
