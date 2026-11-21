/**
 * /admin/events' Luma check, end to end through the real page: only a Techne steward of RegenHub sees it; a
 * site admin with no Techne role, or someone signed out, doesn't. A night posted here through the real write
 * route shows "On Luma" when Luma's feed has it (renamed there) and "Not on Luma" when it doesn't; a Luma-only
 * night offers "Add here", which opens the form prefilled. Faked at the edge, as in techne-steward-gate.test.ts:
 * the platform's AppView, Supabase (PGlite), and Luma's public iCal feed (a local server, sample data).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import type { PGlite } from "@electric-sql/pglite";
import type { FakeAuthUser } from "./pglitePostgrest";
import { doorDb, edgeFetch, type Edge } from "./support/oneDoorHarness";

const browser = vi.hoisted(() => ({ jar: new Map<string, string>() as Map<string, string> }));
vi.mock("next/headers", async () => {
  const { cookieStore } = await import("./support/oneDoorHarness");
  return { cookies: async () => cookieStore(browser.jar), headers: async () => new Headers() };
});
vi.mock("next/cache", () => ({ revalidateTag: () => {}, revalidatePath: () => {} }));
// The page is rendered to HTML with its client parts, outside an app router.
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} }),
}));

import { POST as signinPOST } from "@/app/techne/signin/route";
import { GET as callbackGET } from "@/app/techne/callback/route";
import { POST as writePOST } from "@/app/api/portal/events/write/route";
import EventsPage from "@/app/admin/events/page";
import { StewardEvents } from "@/components/portal/StewardEvents";

const HUB = "did:plc:hublumasync";
const STEWARD = { did: "did:plc:stewardluma", handle: "steward-luma.techne.town", name: "RegenHub manager (sample)" };
const ANA = { did: "did:plc:analuma", handle: "ana-luma.techne.town", name: "Site admin, no role (sample)" };

// Fri 18 Dec 2026 4:20pm Denver on Luma under another name; a Saturday sample night only on Luma.
const FEED = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT", "DTSTART:20261218T232000Z", "DTEND:20261219T012000Z", "UID:evt-SampleHH18@events.lu.ma",
  "SUMMARY:Ugly Sweater Party 420 Happy Hour", "DESCRIPTION:Get up-to-date information at: https://luma.com/samplehh18", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART:20261219T190000Z", "DTEND:20261219T210000Z", "UID:evt-SampleSat19@events.lu.ma",
  "SUMMARY:Sample Saturday Workshop", "LOCATION:RegenHub\\, 1515 Walnut St\\, Boulder\\, CO", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("/admin/events: the Luma check (stand-in)", () => {
  let appview: Server;
  let luma: Server;
  let lumaUp = true;
  let standin: ChildProcess;
  let standinUrl = "";
  let pg: PGlite;
  const realFetch = globalThis.fetch;
  const SITE = "https://preview.test";

  beforeAll(async () => {
    appview = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ records: [] }));
    }).listen(0, "127.0.0.1");
    luma = createServer((_req, res) => {
      res.writeHead(lumaUp ? 200 : 503, { "content-type": "text/calendar" });
      res.end(lumaUp ? FEED : "down");
    }).listen(0, "127.0.0.1");
    await Promise.all([new Promise((r) => appview.once("listening", r)), new Promise((r) => luma.once("listening", r))]);
    const state = mkdtempSync(join(tmpdir(), "t482-luma-sync-"));
    writeFileSync(join(state, "people.json"), JSON.stringify([STEWARD, ANA]));
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
    luma?.close();
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-12-10T12:00:00Z") });
    lumaUp = true;
    vi.stubEnv("REGENOS_BASE_URL", standinUrl);
    vi.stubEnv("REGENOS_COLLECTIVE_DID", HUB);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
    vi.stubEnv("TECHNE_SIGNIN_ENABLED", "true");
    vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
    vi.stubEnv("TECHNE_STANDIN_URL", standinUrl);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    vi.stubEnv("LUMA_ICS_URL", `http://127.0.0.1:${(luma.address() as AddressInfo).port}/ics`);
    pg = await doorDb();
    await pg.query("insert into members (name, email, did, is_admin) values ('Ana', 'ana@example.test', $1, true)", [ANA.did]);
    browser.jar = new Map();
    const edge: Edge = {
      pg, users: new Map<string, FakeAuthUser>(), authByEmail: new Map(), didDocs: new Map(), webDocs: new Map(),
      mails: [], servers: [], passthrough: (u) => u.hostname === "127.0.0.1",
    };
    vi.stubGlobal("fetch", edgeFetch(edge, realFetch));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await pg.close();
  });

  async function signInAs(did: string) {
    browser.jar = new Map();
    const start = await signinPOST(new Request(`${SITE}/techne/signin`, {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ next: "/admin/events" }).toString(),
    }));
    const go = new URL(start.headers.get("location")!);
    const page = await (await realFetch(`${standinUrl}/signin?${go.searchParams}`)).text();
    const back = [...page.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")).find((h) => h.includes(encodeURIComponent(did)))!;
    await callbackGET(new NextRequest(back));
  }

  const post = (rkey: string, name: string, startsAt: string, endsAt: string) =>
    writePOST(new Request(`${SITE}/api/portal/events/write`, {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/json" },
      body: JSON.stringify({ op: "create", input: { rkey, name, startsAt, endsAt, timezone: "America/Denver" } }),
    }));

  const html = async (params: Record<string, string> = {}) =>
    renderToStaticMarkup((await EventsPage({ searchParams: Promise.resolve(params) })) as ReactElement);

  function draftIn(node: ReactNode): unknown {
    if (!isValidElement(node)) return Array.isArray(node) ? node.map(draftIn).find((d) => d !== undefined) : undefined;
    const el = node as ReactElement<{ children?: ReactNode; draft?: unknown }>;
    if (el.type === StewardEvents) return el.props.draft ?? null;
    return draftIn(el.props.children);
  }

  it("a steward sees each night on Luma or not, and the Luma-only nights with Add here", async () => {
    await signInAs(STEWARD.did);
    expect((await post("3maaaaaaaaa2a", "420 Happy Hour", "2026-12-18T23:20:00.000Z", "2026-12-19T01:20:00.000Z")).status).toBe(200);
    expect((await post("3maaaaaaaab2a", "Civic Tech Night", "2026-12-16T01:00:00.000Z", "2026-12-16T03:00:00.000Z")).status).toBe(200);
    const page = await html();
    expect(page).toContain("Also on Luma?");
    expect(page).toContain("1 of 2 not on Luma yet.");
    expect(page).toMatch(/Civic Tech Night<\/span><\/span><span[^>]*>Not on Luma/);
    expect(page).toMatch(/420 Happy Hour<\/span><\/span><a href="https:\/\/luma.com\/samplehh18"/);
    expect(page).toContain("Sample Saturday Workshop");
    expect(page).toContain('href="/admin/events?fromLuma=evt-SampleSat19"');
    expect(page).not.toContain("?fromLuma=evt-SampleHH18");
  });

  it("Add here hands the Luma night to the new-event form", async () => {
    await signInAs(STEWARD.did);
    const el = await EventsPage({ searchParams: Promise.resolve({ fromLuma: "evt-SampleSat19" }) });
    expect(draftIn(el)).toMatchObject({ name: "Sample Saturday Workshop", startAt: "2026-12-19T19:00:00.000Z", placeName: "RegenHub", street: "1515 Walnut St" });
    expect(draftIn(await EventsPage({ searchParams: Promise.resolve({ fromLuma: "evt-unknown" }) }))).toBeNull();
  });

  it("Luma down: the steward's page still works and says so", async () => {
    lumaUp = false;
    await signInAs(STEWARD.did);
    const page = await html();
    expect(page).toContain("Couldn&#x27;t read Luma&#x27;s calendar just now.");
    expect(page).toContain("New event");
  });

  it("a site admin with no Techne role, or someone signed out, doesn't see it", async () => {
    expect(await html()).not.toContain("Also on Luma?");
    await signInAs(ANA.did);
    const page = await html();
    expect(page).toContain("Posting events is for RegenHub&#x27;s facilitators and managers");
    expect(page).not.toContain("Also on Luma?");
    expect(page).not.toContain("Sample Saturday Workshop");
  });
});
