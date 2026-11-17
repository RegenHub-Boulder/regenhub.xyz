/**
 * A steward posts, edits and removes RegenHub's nights as the collective (lib/techne/collectiveEvents.ts,
 * lib/techne/collectiveWrite.ts). First the batch itself (what lands in the collective's repo), then the
 * request (straight to the person's PDS, no atproto-proxy), then end to end: the real staging stand-in
 * (scripts/staging/techne-standin.mjs, spawned) plays the person's PDS, including pds.techne.town's refusal
 * to forward repo writes and the ASSUMED rule that a manager of RegenHub may write its repo; the steward's
 * session is the stand-in session the browser uses, and the site's own read (fetchCollectiveEvents) shows
 * each step. Only the platform's AppView is faked. What the stand-in can't prove: that pds.techne.town lets
 * a manager write the collective's repo. One real post does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { plan } from "techne-sdk/put";
import {
  EVENT_CONFIG_NSID,
  EVENT_LISTING_NSID,
  EVENT_NSID,
  deleteEventBatch,
  putEventBatch,
  type EventInput,
} from "@/lib/techne/collectiveEvents";
import { sendCollectiveBatch, writeErrorText } from "@/lib/techne/collectiveWrite";
import { standInSession } from "@/lib/techne/standIn";
import { platformProxy, signInScope } from "@/lib/techne/session";
import { getSeries, plannedNight } from "@/lib/series";
import { seriesNightInput } from "@/lib/seriesNights";
import { buildUpdateEventInput, eventBodyToFormValues } from "@/lib/regenos/eventForm";
import { fetchCollectiveEvents } from "@/lib/regenos/events";
import type { TechneConfig } from "@/lib/techne/config";

const HUB = "did:plc:hubwrites";
const STEWARD = "did:plc:stewardwrites";
const MEMBER = "did:plc:memberwrites";
const NOW = new Date("2026-11-17T20:00:00Z");
const agents = getSeries("agents-night")!;
const night = () => seriesNightInput(plannedNight(agents, "2026-12-01"), HUB) as unknown as EventInput;

describe("the batch", () => {
  it("a new night: event, config and listing in the collective's repo, the last two pointing at the event", () => {
    const input = night();
    const b = putEventBatch(HUB, input, null, NOW);
    expect(b.input.repo).toBe(HUB);
    expect(b.input.writes.map((w) => [w.$type.split("#")[1], w.collection, w.rkey])).toEqual([
      ["create", EVENT_NSID, input.rkey],
      ["create", EVENT_CONFIG_NSID, `${input.rkey}-cfg`],
      ["create", EVENT_LISTING_NSID, `${input.rkey}-ctx`],
    ]);
    expect(input.rkey).toMatch(/^[234567a-z]{13}$/); // a TID, as the event lexicon declares
    const [ev, cfg, ctx] = b.input.writes as { value: Record<string, unknown> }[];
    const [planned] = plan(HUB, [{ record: ev.value as never, rkey: input.rkey }], NOW);
    expect(cfg.value.event).toEqual({ uri: planned.uri, cid: planned.cid });
    expect(ctx.value.event).toEqual({ uri: planned.uri, cid: planned.cid });
    expect(cfg.value).toMatchObject({ timezone: "America/Denver", attendance: "open" });
    expect(ev.value).toMatchObject({
      $type: EVENT_NSID,
      name: "Agents Night",
      startsAt: plannedNight(agents, "2026-12-01").startsAt,
      createdAt: NOW.toISOString(),
      locations: [expect.objectContaining({ $type: "community.lexicon.location.address", locality: "Boulder", country: "US" })],
    });
    expect(b.uris).toHaveLength(3);
  });

  it("an edit keeps the key, createdAt, fields the form doesn't own, and the config's own settings", () => {
    const value = {
      $type: EVENT_NSID,
      name: "420 Happy Hour",
      createdAt: "2026-11-06T23:20:00.000Z",
      startsAt: "2026-11-06T23:20:00.000Z",
      rsvpExpected: true,
      uris: [{ uri: "https://regenhub.xyz/events/agents-night" }],
      locations: [{ $type: "community.lexicon.location.geo", latitude: "40.0", longitude: "-105.2" }],
    };
    const existing = {
      rkey: "ev-mtishcrx6pltz6",
      value,
      config: { $type: EVENT_CONFIG_NSID, waitlist: true, attendance: "approval", createdAt: "2026-11-06T23:20:00.000Z" },
      hasListing: false,
    };
    const form = { ...eventBodyToFormValues(value, "public"), name: "Agents Night: local models" };
    const b = putEventBatch(HUB, buildUpdateEventInput(form, { authority: HUB, rkey: existing.rkey }) as unknown as EventInput, existing, NOW);
    expect(b.input.writes.map((w) => [w.$type.split("#")[1], w.rkey])).toEqual([
      ["update", "ev-mtishcrx6pltz6"],
      ["update", "ev-mtishcrx6pltz6-cfg"],
      ["create", "ev-mtishcrx6pltz6-ctx"],
    ]);
    const [ev, cfg] = b.input.writes as { value: Record<string, unknown> }[];
    expect(ev.value).toMatchObject({ name: "Agents Night: local models", createdAt: value.createdAt, rsvpExpected: true, uris: value.uris });
    expect(ev.value.locations).toEqual([value.locations[0]]); // the geo point stays; no empty address
    expect(cfg.value).toMatchObject({ waitlist: true, attendance: "approval", timezone: "America/Denver", createdAt: value.createdAt });
  });

  it("removing deletes the event and only the siblings that exist", () => {
    const b = deleteEventBatch(HUB, { rkey: "k", value: {}, config: null, hasListing: true });
    expect(b.input.writes).toEqual([
      { $type: "com.atproto.repo.applyWrites#delete", collection: EVENT_LISTING_NSID, rkey: "k-ctx" },
      { $type: "com.atproto.repo.applyWrites#delete", collection: EVENT_NSID, rkey: "k" },
    ]);
  });
});

describe("the request", () => {
  const config = { clientId: "https://preview.test/techne/client-metadata.json", redirectUri: "https://preview.test/techne/callback" };
  it("goes to the person's own PDS as applyWrites on the collective's repo, with no atproto-proxy; only the index hints are proxied", async () => {
    const calls: { path: string; headers: Headers; body: Record<string, unknown> }[] = [];
    // The OAuth session's fetchHandler resolves a path against the person's PDS: that is where it goes.
    const s = {
      did: STEWARD,
      fetchHandler: async (path: string, init: RequestInit) => {
        calls.push({ path, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
        return Response.json({});
      },
    };
    const batch = putEventBatch(HUB, night(), null);
    expect(await sendCollectiveBatch(s, config, batch)).toEqual({ ok: true });
    const [write, ...hints] = calls;
    expect(write.path).toBe("/xrpc/com.atproto.repo.applyWrites");
    expect(write.headers.has("atproto-proxy")).toBe(false);
    expect(write.body.repo).toBe(HUB);
    expect(hints.map((h) => [h.path, h.headers.get("atproto-proxy")])).toEqual(
      batch.uris.map(() => ["/xrpc/pub.techne.draft.sync.indexRecord", platformProxy(config)]),
    );
  });
});

describe("what the steward is told when a write doesn't land", () => {
  const config = { clientId: "https://preview.test/techne/client-metadata.json", redirectUri: "https://preview.test/techne/callback" };
  const batch = () => putEventBatch(HUB, night(), null);
  const answering = (status: number, body: unknown) => ({ did: STEWARD, fetchHandler: async () => Response.json(body, { status }) });
  it("a refusal says Techne didn't accept a post as RegenHub, in Techne's own words, not that the role is wrong", async () => {
    const out = await sendCollectiveBatch(answering(403, { error: "Forbidden", message: "may not write as the collective" }), config, batch());
    expect(out).toMatchObject({ ok: false, kind: "refused", status: 403 });
    const text = writeErrorText(out as Exclude<typeof out, { ok: true }>);
    expect(text).toContain("Techne didn't accept a post as RegenHub from this account");
    expect(text).toContain("may not write as the collective");
    expect(text).not.toMatch(/steward|facilitator|manage RegenHub's membership/);
    // A PDS that answers "not your repo" with 401 AuthRequired is the same refusal, not a lapsed sign-in.
    expect(await sendCollectiveBatch(answering(401, { error: "AuthenticationRequired" }), config, batch())).toMatchObject({ kind: "refused" });
  });
  it("a token the PDS no longer accepts says to sign in again", async () => {
    expect(await sendCollectiveBatch(answering(401, { error: "ExpiredToken" }), config, batch())).toMatchObject({ ok: false, kind: "signin" });
    expect(await sendCollectiveBatch(answering(400, { error: "ExpiredToken" }), config, batch())).toMatchObject({ ok: false, kind: "signin" });
    expect(await sendCollectiveBatch(answering(400, { error: "invalid_dpop_proof" }), config, batch())).toMatchObject({ ok: false, kind: "signin" });
    // The OAuth way: no body, the name in WWW-Authenticate.
    const challenged = { did: STEWARD, fetchHandler: async () => new Response("", { status: 401, headers: { "www-authenticate": 'DPoP error="invalid_token", error_description="expired"' } }) };
    expect(await sendCollectiveBatch(challenged, config, batch())).toMatchObject({ ok: false, kind: "signin", message: expect.stringContaining("expired") });
    // A generic body name doesn't hide the challenge; an unquoted challenge counts.
    const both = (h: string) => ({ did: STEWARD, fetchHandler: async () => Response.json({ error: "AuthenticationRequired" }, { status: 401, headers: { "www-authenticate": h } }) });
    expect(await sendCollectiveBatch(both('DPoP error="invalid_token"'), config, batch())).toMatchObject({ kind: "signin" });
    expect(await sendCollectiveBatch(both("DPoP error=invalid_token"), config, batch())).toMatchObject({ kind: "signin" });
    expect(await sendCollectiveBatch(both('DPoP error="use_dpop_nonce"'), config, batch())).toMatchObject({ kind: "failed" });
  });
  it("a 5xx that names a bad token may still have landed: reload first", async () => {
    expect(await sendCollectiveBatch(answering(502, { error: "InvalidToken" }), config, batch())).toMatchObject({ ok: false, kind: "unknown" });
    // A bare 401 (no error name, not even JSON) is a refusal; its text also says to sign in again.
    const bare = { did: STEWARD, fetchHandler: async () => new Response("no json", { status: 401 }) };
    expect(await sendCollectiveBatch(bare, config, batch())).toMatchObject({ ok: false, kind: "refused" });
  });
  it("a 5xx may have landed: check before retrying", async () => {
    expect(await sendCollectiveBatch(answering(504, { error: "UpstreamTimeout" }), config, batch())).toMatchObject({ ok: false, kind: "unknown" });
  });
  it("no answer at all may have landed: check before retrying", async () => {
    const s = { did: STEWARD, fetchHandler: async () => { throw new TypeError("fetch failed"); } };
    expect(await sendCollectiveBatch(s, config, batch())).toMatchObject({ ok: false, kind: "unknown" });
  });
  it("an error answer wrote nothing", async () => {
    expect(await sendCollectiveBatch(answering(400, { error: "InvalidRequest" }), config, batch())).toMatchObject({ ok: false, kind: "failed" });
  });
});

describe("the one sign-in", () => {
  const config = { clientId: "https://regenhub.xyz/techne/client-metadata.json" };
  it("asks everyone for the public types the site writes and the default reads; nothing that brings the red warning", () => {
    const scope = signInScope(config);
    const repo = scope.filter((x) => x.startsWith("repo"));
    for (const t of ["community.lexicon.calendar.rsvp", EVENT_NSID, EVENT_CONFIG_NSID, EVENT_LISTING_NSID]) {
      expect(repo.some((x) => x.startsWith(`repo:${t}?`))).toBe(true);
    }
    expect(scope).toContain("rpc:pub.techne.draft.sync.indexRecord?aud=did:web:techne.computer%23atproto_appview");
    // building-an-app.md *Permissions*: authRead, authWrite or any space: but the app's own is the red warning.
    expect(scope.join(" ")).not.toMatch(/authRead|authWrite|applyWrites/);
    expect(scope.filter((x) => x.startsWith("space:"))).toEqual([expect.stringMatching(/^space:pub\.techne\.draft\.space\.private\?skey=/)]);
  });
});

describe("end to end through the stand-in", () => {
  let appview: Server;
  let standin: ChildProcess;
  let base = "";
  const config: TechneConfig = { clientId: "https://preview.test/techne/client-metadata.json", redirectUri: "https://preview.test/techne/callback" };

  beforeAll(async () => {
    appview = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ records: [] }));
    }).listen(0, "127.0.0.1");
    await new Promise((r) => appview.once("listening", r));
    const state = mkdtempSync(join(tmpdir(), "t482-writes-"));
    writeFileSync(join(state, "people.json"), JSON.stringify([]));
    // The collective's public claim that STEWARD manages it (role 40), as the stand-in seeds from seed.json.
    writeFileSync(join(state, "seed.json"), JSON.stringify({ collective: HUB, steward: STEWARD, events: {} }));
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
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      if (await fetch(`${base}/signin?redirect=http://x/`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    process.env.REGENOS_BASE_URL = base;
    process.env.REGENOS_COLLECTIVE_DID = HUB;
  }, 20_000);

  afterAll(() => {
    standin?.kill();
    appview?.close();
    delete process.env.REGENOS_BASE_URL;
    delete process.env.REGENOS_COLLECTIVE_DID;
  });

  const calendar = async () => (await fetchCollectiveEvents({ revalidate: 0 })) ?? [];

  it("the old proxy route is refused as pds.techne.town refuses it, and nothing is written", async () => {
    const steward = standInSession(base, STEWARD);
    const viaProxy = { did: STEWARD, fetchHandler: (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set("atproto-proxy", platformProxy(config));
      return steward.fetchHandler(path, { ...init, headers });
    } };
    const out = await sendCollectiveBatch(viaProxy, config, putEventBatch(HUB, night(), null));
    expect(out).toMatchObject({ ok: false, kind: "refused" });
    expect((out as { message: string }).message).toContain("is not forwarded");
    expect(await calendar()).toEqual([]);
  });

  it("someone who doesn't manage RegenHub is refused, and nothing is written", async () => {
    const out = await sendCollectiveBatch(standInSession(base, MEMBER), config, putEventBatch(HUB, night(), null));
    expect(out).toMatchObject({ ok: false, kind: "refused" });
    expect(await calendar()).toEqual([]);
  });

  it("a sign-in the PDS doesn't accept says to sign in again, not that you lack the role", async () => {
    const steward = standInSession(base, STEWARD);
    const lapsed = { did: STEWARD, fetchHandler: (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set("x-standin-expired", "1");
      return steward.fetchHandler(path, { ...init, headers });
    } };
    expect(await sendCollectiveBatch(lapsed, config, putEventBatch(HUB, night(), null))).toMatchObject({ ok: false, kind: "signin" });
    expect(await calendar()).toEqual([]);
  });

  it("a steward posts a night, edits it, and removes it; the site's read follows", async () => {
    const steward = standInSession(base, STEWARD);
    const input = night();
    expect(await sendCollectiveBatch(steward, config, putEventBatch(HUB, input, null))).toEqual({ ok: true });
    let [posted] = await calendar();
    expect(posted).toMatchObject({ did: HUB, rkey: input.rkey, name: "Agents Night", series: expect.objectContaining({ slug: "agents-night" }) });

    const form = { ...eventBodyToFormValues(posted.value, "public"), name: "Agents Night: local models" };
    const existing = { rkey: posted.rkey, value: posted.value as Record<string, unknown>, config: { $type: EVENT_CONFIG_NSID, attendance: "open", createdAt: "x" }, hasListing: true };
    const edit = putEventBatch(HUB, buildUpdateEventInput(form, { authority: HUB, rkey: posted.rkey }) as unknown as EventInput, existing);
    expect(await sendCollectiveBatch(steward, config, edit)).toEqual({ ok: true });
    [posted] = await calendar();
    expect(posted.name).toBe("Agents Night: local models");

    expect(await sendCollectiveBatch(steward, config, deleteEventBatch(HUB, existing))).toEqual({ ok: true });
    expect(await calendar()).toEqual([]);
  });
});
