/**
 * "Sign in with Techne" as the RSVP door, end to end in node:
 *  - the client metadata route (flag off: 404; on: techne-sdk's document, least privilege);
 *  - sign-in start and restore through the real techne-sdk/auth, with the staging stand-in
 *    injected as the OAuth client (the SDK's documented `setOAuthClientFactory` seam);
 *  - the RSVP written with that session to the stand-in for the person's PDS (the real
 *    scripts/staging/techne-standin.mjs, spawned), then read back through Techne's documented
 *    query as the page's going count;
 *  - the staging proxy route stays shut unless the stand-in is switched on.
 * Only the platform's AppView is faked (a tiny HTTP server), as a system outside this repo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { GET as clientMetadataGET } from "@/app/techne/client-metadata.json/route";
import { GET as stagingGET } from "@/app/staging/techne/[...path]/route";
import { NextRequest } from "next/server";
import { rsvpConfig } from "@/lib/techne/rsvpConfig";
import { authOptions, safeReturn } from "@/lib/techne/session";
import { writeRsvp } from "@/components/events/RsvpPanel";
import { fetchAttendance } from "@/lib/regenos/events";

const HUB = "did:plc:hubtest";
const EVENT = { uri: `at://${HUB}/community.lexicon.calendar.event/3n2aaaaaaaaa2`, cid: "bafyevent" };
const PERSON = { did: "did:plc:leetest", handle: "lee-sample.techne.town", name: "Lee (sample)", cookie: "" };

let appview: Server;
let standin: ChildProcess;
let standinUrl = "";

function setEnv(on: boolean) {
  process.env.REGENOS_BASE_URL = standinUrl || "http://127.0.0.1:1";
  process.env.REGENOS_COLLECTIVE_DID = HUB;
  process.env.NEXT_PUBLIC_SITE_URL = "https://preview.test";
  if (on) process.env.TECHNE_RSVP_ENABLED = "true";
  else delete process.env.TECHNE_RSVP_ENABLED;
}

beforeAll(async () => {
  // A stand-in AppView: answers the documented query with no records of its own.
  appview = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ records: [] }));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => appview.once("listening", r));
  const state = mkdtempSync(join(tmpdir(), "t482-standin-"));
  writeFileSync(join(state, "people.json"), JSON.stringify([PERSON]));
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
    if (await fetch(`${standinUrl}/signin`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}, 20_000);

afterAll(() => {
  standin?.kill();
  appview?.close();
});

beforeEach(() => {
  setEnv(true);
  delete process.env.TECHNE_STAGING_STANDIN;
});

describe("client metadata (regenhub.xyz's OAuth client id)", () => {
  it("404s while RSVP is off", async () => {
    setEnv(false);
    expect(clientMetadataGET().status).toBe(404);
    expect(rsvpConfig()).toBeNull();
  });

  it("serves techne-sdk's document at its own URL, asking only for RSVP writes", async () => {
    const doc = await clientMetadataGET().json();
    expect(doc.client_id).toBe("https://preview.test/techne/client-metadata.json");
    expect(doc.redirect_uris).toEqual(["https://preview.test/techne/callback"]);
    expect(doc.token_endpoint_auth_method).toBe("none");
    expect(doc.dpop_bound_access_tokens).toBe(true);
    const scope = String(doc.scope).split(" ");
    expect(scope).toContain("atproto");
    expect(scope.filter((s) => s.startsWith("repo:"))).toEqual([
      "repo:community.lexicon.calendar.rsvp?action=create&action=update&action=delete",
    ]);
    expect(scope).toContain("rpc:pub.techne.draft.sync.indexRecord?aud=did:web:techne.computer%23atproto_appview");
    expect(scope.some((s) => s.includes("authRead") || s.includes("authWrite"))).toBe(false);
  });

  it("never turns the stand-in on for the production origin", () => {
    process.env.TECHNE_STAGING_STANDIN = "1";
    process.env.NEXT_PUBLIC_SITE_URL = "https://regenhub.xyz";
    expect(rsvpConfig()?.standIn).toBeUndefined();
    process.env.NEXT_PUBLIC_SITE_URL = "https://preview.test";
    expect(rsvpConfig()?.standIn).toBe("/staging/techne");
  });
});

describe("staging route", () => {
  const call = (path: string) =>
    stagingGET(new NextRequest(`https://preview.test/staging/techne/${path}?redirect=https://preview.test/techne/callback`), {
      params: Promise.resolve({ path: path.split("/") }),
    });

  it("404s when the stand-in is off", async () => {
    process.env.TECHNE_STANDIN_URL = standinUrl;
    expect((await call("signin")).status).toBe(404);
  });

  it("serves the stand-in's sign-in page when on", async () => {
    process.env.TECHNE_STAGING_STANDIN = "1";
    process.env.TECHNE_STANDIN_URL = standinUrl;
    const res = await call("signin");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Lee (sample)");
  });
});

describe("Sign in with Techne → RSVP", () => {
  it("starts sign-in, restores the session on the callback, and RSVPs with it", async () => {
    process.env.TECHNE_STAGING_STANDIN = "1";
    const config = rsvpConfig()!;
    // A browser window for the SDK: the stand-in's base goes straight to the spawned server here.
    const store = new Map<string, string>();
    const location = new URL("https://preview.test/events/did%3Aplc%3Ahubtest/3n2aaaaaaaaa2") as URL & {
      assign: (u: string) => void;
    };
    let assigned = "";
    const win = {
      location: Object.assign(location, { assign: (u: string) => void (assigned = u) }),
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      fetch: (u: string, init?: RequestInit) => fetch(u.replace(config.standIn!, standinUrl), init),
    };
    (globalThis as { window?: unknown }).window = win;
    (globalThis as { location?: unknown }).location = win.location;

    const auth = await import("techne-sdk/auth");
    const opts = await authOptions(config);

    // Signed out at first.
    expect(await auth.restore(opts)).toBeNull();

    // Start: the SDK hands the redirect to the OAuth client, which goes to the sign-in page.
    await auth.signIn({ ...opts, state: "/events/did%3Aplc%3Ahubtest/3n2aaaaaaaaa2" });
    const go = new URL(assigned);
    expect(go.pathname).toBe("/staging/techne/signin");
    expect(go.searchParams.get("redirect")).toBe("https://preview.test/techne/callback");
    const page = await (await fetch(`${standinUrl}/signin?${go.searchParams}`)).text();
    const back = /href="([^"]+)"/.exec(page)![1].replace(/&amp;/g, "&");

    // Come back: restore finishes the sign-in, redirectState gives back the page we started on.
    await auth.signOut({ ...opts, session: { did: PERSON.did } as never }).catch(() => {});
    win.location.href = back;
    const session = (await auth.restore(opts)) as unknown as {
      did: string;
      fetchHandler: (p: string, i: RequestInit) => Promise<Response>;
    };
    expect(session.did).toBe(PERSON.did);
    expect(safeReturn(await auth.redirectState(opts))).toBe("/events/did%3Aplc%3Ahubtest/3n2aaaaaaaaa2");

    // RSVP with the session: the person's own record, then read back as the going count.
    expect((await fetchAttendance(EVENT.uri))?.going).toBe(0);
    const rkey = await writeRsvp(session, config, EVENT, "going");
    expect(rkey).toMatch(/^[234567a-j][234567a-z]{12}$/);
    expect(await fetchAttendance(EVENT.uri)).toEqual({ going: 1, goingDids: [PERSON.did] });

    // Changing their mind rewrites the same record, not a second one.
    await writeRsvp(session, config, EVENT, "notgoing", rkey);
    expect((await fetchAttendance(EVENT.uri))?.going).toBe(0);
    const own = await (
      await session.fetchHandler(
        `/xrpc/com.atproto.repo.listRecords?repo=${PERSON.did}&collection=community.lexicon.calendar.rsvp`,
        {},
      )
    ).json();
    expect(own.records).toHaveLength(1);
  });

  it("refuses a write into someone else's repo", async () => {
    const res = await fetch(`${standinUrl}/xrpc/com.atproto.repo.putRecord`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-standin-did": "did:plc:mallory" },
      body: JSON.stringify({ repo: PERSON.did, collection: "community.lexicon.calendar.rsvp", rkey: "x", record: {} }),
    });
    expect(res.status).toBe(403);
  });
});
