/**
 * The stewards' events page (/admin/events) and its write route answer to the Techne role in RegenHub, the same
 * check as /admin/stewards (lib/techne/roster.ts stewardCheck), not to a site membership. End to end through the
 * real routes: "Sign in with Techne" (POST /techne/signin → the staging stand-in's sign-in → /techne/callback),
 * the page, and POST /api/portal/events/write, which writes as RegenHub through writeAsCollective on the stand-in
 * (scripts/staging/techne-standin.mjs, spawned: the person's PDS and Techne's write-as-collective, which itself
 * lets only facilitator+ of RegenHub write). Faked: the platform's AppView (a tiny HTTP server answering no
 * records) and, at the network edge, Supabase (PGlite + migration 064). Next's cache is stubbed: no Next server.
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
import { doorDb, edgeFetch, portalSessionEmail, type Edge } from "./support/oneDoorHarness";

const browser = vi.hoisted(() => ({ jar: new Map<string, string>() as Map<string, string>, path: null as string | null }));
vi.mock("next/headers", async () => {
  const { cookieStore } = await import("./support/oneDoorHarness");
  return {
    cookies: async () => cookieStore(browser.jar),
    headers: async () => new Headers(browser.path ? { "x-pathname": browser.path } : {}),
  };
});
vi.mock("next/cache", () => ({ revalidateTag: () => {}, revalidatePath: () => {} }));

import { POST as signinPOST } from "@/app/techne/signin/route";
import { GET as callbackGET } from "@/app/techne/callback/route";
import { POST as stewardsPOST } from "@/app/api/techne/stewards/route";
import { POST as writePOST } from "@/app/api/portal/events/write/route";
import EventsPage from "@/app/admin/events/page";
import OldPortalEventsPage from "@/app/portal/events/page";
import PortalLayout from "@/app/portal/layout";
import { StewardEvents } from "@/components/portal/StewardEvents";
import type { ManageableEvent } from "@/components/portal/ManageEvents";
import { safeReturn } from "@/lib/techne/session";

const HUB = "did:plc:hubevents";
const STEWARD = { did: "did:plc:stewardev", handle: "steward-ev.techne.town", name: "RegenHub manager (sample)" };
const UNI = { did: "did:plc:unisample", handle: "uni-sample.techne.town", name: "Facilitator, no membership (sample)" };
const ANA = { did: "did:plc:anaevents", handle: "ana-ev.techne.town", name: "Site admin, no role (sample)" };

describe("sign-in comes back where it started (the one door), never to another site", () => {
  it("returns to any page on this site, resolved, and nowhere else", () => {
    expect(safeReturn("/admin/events")).toBe("/admin/events");
    expect(safeReturn("/portal")).toBe("/portal");
    expect(safeReturn("/apply")).toBe("/apply");
    expect(safeReturn("/auth/techne/link?code=abc")).toBe("/auth/techne/link?code=abc");
    // What is checked is what gets followed: dot segments resolve before the check.
    expect(safeReturn("/portal/events/../../admin")).toBe("/admin");
    expect(safeReturn("https://evil.example/portal/events")).toBe("/events");
    expect(safeReturn("//evil.example/portal")).toBe("/events");
    expect(safeReturn("/\\evil.example")).toBe("/events");
    expect(safeReturn("/.//evil.example")).toBe("/events");
    expect(safeReturn(null)).toBe("/events");
  });
});

/** Where a server component's redirect() points, or null if it didn't redirect. */
async function redirectOf(run: () => unknown): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    const digest = String((err as { digest?: string })?.digest ?? "");
    if (!digest.startsWith("NEXT_REDIRECT")) throw err;
    return digest.split(";")[2];
  }
}

describe("/admin/events: the Techne role, not a site membership (stand-in)", () => {
  let appview: Server;
  let standin: ChildProcess;
  let standinUrl = "";
  let pg: PGlite;
  let edge: Edge;
  const realFetch = globalThis.fetch;
  const SITE = "https://preview.test";

  beforeAll(async () => {
    appview = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ records: [] }));
    }).listen(0, "127.0.0.1");
    await new Promise((r) => appview.once("listening", r));
    const state = mkdtempSync(join(tmpdir(), "t482-events-gate-"));
    writeFileSync(join(state, "people.json"), JSON.stringify([STEWARD, UNI, ANA]));
    // RegenHub's founder claim for STEWARD (role 40), as production Techne has for Aaron.
    writeFileSync(join(state, "seed.json"), JSON.stringify({ collective: HUB, steward: STEWARD.did, events: {} }));
    const port = 20000 + Math.floor(Math.random() * 20000);
    standin = spawn(
      process.execPath,
      [
        resolve(__dirname, "../../../scripts/staging/techne-standin.mjs"),
        "--port", String(port),
        "--appview", `http://127.0.0.1:${(appview.address() as AddressInfo).port}`,
        "--state", state,
      ],
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
    pg = await doorDb();
    // Ana is a RegenHub admin on this site with her Techne account linked, but holds no role in RegenHub on Techne.
    await pg.query("insert into members (name, email, did, is_admin) values ('Ana', 'ana@example.test', $1, true)", [ANA.did]);
    browser.jar = new Map();
    browser.path = null;
    edge = {
      pg,
      users: new Map<string, FakeAuthUser>(),
      authByEmail: new Map(),
      didDocs: new Map(),
      webDocs: new Map(),
      mails: [],
      servers: [],
      passthrough: (u) => u.hostname === "127.0.0.1",
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
    const landed = await callbackGET(new NextRequest(back));
    // A non-member lands on the page they asked for, not on the login page's "Already a member?".
    expect(new URL(landed.headers.get("location")!).pathname).toBe("/admin/events");
  }

  const write = async (body: Record<string, unknown>) => {
    const res = await writePOST(
      new Request(`${SITE}/api/portal/events/write`, {
        method: "POST",
        headers: { origin: SITE, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, ...((await res.json()) as { ok?: boolean; error?: string }) };
  };

  const night = (rkey: string, name: string) => ({
    op: "create",
    input: { rkey, name, startsAt: "2026-12-01T18:00:00-07:00", endsAt: "2026-12-01T20:00:00-07:00", timezone: "America/Denver" },
  });

  /** The form's props when the page shows it, else null. */
  function formIn(node: ReactNode): { events: ManageableEvent[]; role: string | null } | null {
    if (!isValidElement(node)) return Array.isArray(node) ? (node.map(formIn).find(Boolean) ?? null) : null;
    const el = node as ReactElement<{ children?: ReactNode; events?: ManageableEvent[]; role?: string | null }>;
    if (el.type === StewardEvents) return { events: el.props.events ?? [], role: el.props.role ?? null };
    return formIn(el.props.children);
  }
  const page = async () => (await EventsPage()) as ReactElement;
  const names = async () => formIn(await page())?.events.map((e) => e.name) ?? null;

  it("signed out: the page offers Techne sign-in, no form, and the write route refuses", async () => {
    const p = await page();
    expect(formIn(p)).toBeNull();
    expect(renderToStaticMarkup(p)).toContain("Sign in with Techne to manage events");
    expect(await write(night("3maaaaaaaaa2a", "Should not land"))).toMatchObject({ status: 401, ok: false });
  });

  it("old links: /portal/events goes to /admin/events before the portal asks for a member session", async () => {
    browser.path = "/portal/events";
    expect(await redirectOf(() => PortalLayout({ children: null }))).toBe("/admin/events");
    expect(await redirectOf(() => OldPortalEventsPage())).toBe("/admin/events");
    // The rest of the portal still asks for a member session.
    browser.path = "/portal/profile";
    expect(await redirectOf(() => PortalLayout({ children: null }))).toMatch(/^\/auth\/login\?next=/);
  });

  it("a manager with no site membership gets the form and posts a night", async () => {
    await signInAs(STEWARD.did);
    expect(portalSessionEmail(browser.jar)).toBeNull(); // no member row has this DID: no portal session at all
    expect(await names()).toEqual([]);
    expect(await write(night("3maaaaaaaab2a", "Agents Building Night"))).toEqual({ status: 200, ok: true });
    expect(await names()).toEqual(["Agents Building Night"]);
  });

  it("a facilitator with no site membership (Uni's case) gets the form and posts", async () => {
    // The manager makes Uni a facilitator (30) on Techne, through /admin/stewards.
    await signInAs(STEWARD.did);
    const added = await stewardsPOST(
      new Request(`${SITE}/api/techne/stewards`, {
        method: "POST",
        headers: { origin: SITE, "content-type": "application/json" },
        body: JSON.stringify({ op: "add", handle: UNI.handle, role: 30 }),
      }),
    );
    expect(added.status).toBe(200);

    await signInAs(UNI.did);
    expect(portalSessionEmail(browser.jar)).toBeNull();
    expect(formIn(await page())?.role).toBe("facilitator");
    expect(await write(night("3maaaaaaaac2a", "Civic Tech Night"))).toEqual({ status: 200, ok: true });
    expect(await names()).toEqual(expect.arrayContaining(["Agents Building Night", "Civic Tech Night"]));
  });

  it("a site admin and member with no Techne role gets the explainer and no form; the route refuses, nothing lands", async () => {
    await signInAs(ANA.did);
    expect(portalSessionEmail(browser.jar)).toBe("ana@example.test"); // the one door gave her a portal session
    const p = await page();
    expect(formIn(p)).toBeNull();
    const html = renderToStaticMarkup(p);
    expect(html).toContain("Posting events is for RegenHub&#x27;s facilitators and managers");
    expect(html).toContain(`@${STEWARD.handle}`);
    const out = await write(night("3maaaaaaaad2a", "Ana's night"));
    expect(out).toMatchObject({ status: 403, ok: false, error: expect.stringContaining("Only RegenHub's facilitators and managers") });

    await signInAs(STEWARD.did);
    expect(await names()).not.toContain("Ana's night");
  });
});
