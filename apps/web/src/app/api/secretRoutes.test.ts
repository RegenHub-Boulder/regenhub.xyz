import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseMock } from "../../../test/mockSupabase";

/**
 * Every route that authenticates a caller by a shared secret in
 * `Authorization: Bearer …`: wrong, wrong-length, missing or unset-env
 * secrets are refused before any service-role work; the right secret gets
 * through to the route's normal work.
 *
 * Supabase and the network are faked (they're outside this repo); the
 * secret check itself is the real code.
 */

vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createServiceClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

type SecretRoute = {
  name: string;
  env: string;
  /** Status for a caller whose secret doesn't match. */
  refused: number;
  /** Status for every caller when the secret env is unset or empty. */
  unsetStatus: number;
  load: () => Promise<Handler>;
  /** Body a real caller would send. */
  body?: object;
  /** What the route's normal work looks like once the secret passes.
   *  Default: it reaches for the service-role client. */
  passed?: (res: Response) => Promise<void>;
};

const ROUTES: SecretRoute[] = [
  { name: "cron/admin-digest", env: "CRON_SECRET", refused: 401, unsetStatus: 503, load: async () => (await import("./cron/admin-digest/route")).POST },
  { name: "cron/door-watchdog", env: "CRON_SECRET", refused: 401, unsetStatus: 503, load: async () => (await import("./cron/door-watchdog/route")).POST },
  { name: "cron/hub-health-digest", env: "CRON_SECRET", refused: 401, unsetStatus: 503, load: async () => (await import("./cron/hub-health-digest/route")).POST },
  { name: "cron/lifecycle-nudges", env: "CRON_SECRET", refused: 401, unsetStatus: 503, load: async () => (await import("./cron/lifecycle-nudges/route")).POST },
  {
    name: "cron/newsletter", env: "CRON_SECRET", refused: 401, unsetStatus: 503,
    load: async () => (await import("./cron/newsletter/route")).POST,
    // NEWSLETTER_AUTOSEND_ENABLED is unset, so the normal answer is the kill switch.
    passed: async (res) => {
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ skipped: true });
    },
  },
  { name: "cron/past-due-sweep", env: "CRON_SECRET", refused: 401, unsetStatus: 503, load: async () => (await import("./cron/past-due-sweep/route")).POST },
  { name: "cron/sync-access-logs", env: "CRON_SECRET", refused: 401, unsetStatus: 503, load: async () => (await import("./cron/sync-access-logs/route")).POST },
  {
    name: "access-events", env: "HA_WEBHOOK_SECRET", refused: 401, unsetStatus: 503,
    load: async () => (await import("./access-events/route")).POST,
    body: { method: "pin", slot: 12, result: "granted", note: "lock.front_door_lock" },
    passed: async (res) => {
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    },
  },
  // A failed secret ⇒ the system lane is closed and the caller falls
  // through to the admin-session check, which a bare bearer can't pass.
  { name: "admin/applications/[id]/send-checkout-email", env: "CRON_SECRET", refused: 403, unsetStatus: 403, load: async () => (await import("./admin/applications/[id]/send-checkout-email/route")).POST },
];

const SECRET = "test-secret-0123456789";
const ctx = { params: Promise.resolve({ id: "1" }) };
const savedEnv = { ...process.env };

function call(handler: Handler, authorization?: string, body: object = {}) {
  return handler(
    new Request("http://localhost/api/x", {
      method: "POST",
      headers: authorization === undefined ? {} : { Authorization: authorization },
      body: JSON.stringify(body),
    }),
    ctx,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  vi.mocked(createServiceClient).mockReturnValue(makeSupabaseMock() as never);
  // No browser session: only the secret can let a caller in.
  vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ auth: { user: null } }) as never);
  process.env.HA_URL = "http://ha.test/api";
  process.env.HA_TOKEN = "ha-token";
  process.env.HA_LOCK_ENTITIES = "lock.front_door_lock";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

describe.each(ROUTES)("$name", ({ env, refused, unsetStatus, load, body, passed }) => {
  // A cold route import can outlast the default 5s test timeout.
  beforeAll(async () => { await load(); }, 30_000);

  it.each([
    ["missing header", undefined],
    ["wrong secret, same length", `Bearer ${"x".repeat(SECRET.length)}`],
    ["wrong length (prefix)", `Bearer ${SECRET.slice(0, -1)}`],
    ["wrong length (extended)", `Bearer ${SECRET}x`],
    ["empty bearer", "Bearer "],
    ["no scheme", SECRET],
  ])("refuses %s, before any service-role work", async (_label, authorization) => {
    process.env[env] = SECRET;
    const res = await call(await load(), authorization, body);
    expect(res.status).toBe(refused);
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("refuses every caller when the secret is %s", async (_label, value) => {
    if (value === undefined) delete process.env[env];
    else process.env[env] = value;
    const handler = await load();
    for (const authorization of ["Bearer ", "Bearer undefined", undefined]) {
      const res = await call(handler, authorization, body);
      expect(res.status).toBe(unsetStatus);
    }
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it("lets the right secret through to the route's work", async () => {
    process.env[env] = SECRET;
    const res = await call(await load(), `Bearer ${SECRET}`, body);
    expect([401, 403, 503]).not.toContain(res.status);
    if (passed) await passed(res);
    else expect(createServiceClient).toHaveBeenCalled();
  });
});

/**
 * Grep-as-a-test: no route compares a bearer header with `===`/`!==`.
 * The sibling admin-cancel branch owns cron/onchain-billing; drop it from
 * this list once that branch lands and the route uses hasBearerSecret.
 */
const SIBLING_OWNED = new Set(["cron/onchain-billing/route.ts"]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

const root = __dirname;
const checkedRoutes = () => routeFiles(root).filter((f) => !SIBLING_OWNED.has(relative(root, f)));

it("no API route compares a bearer secret with === or !==", () => {
  // Either operand order, template or string literal.
  const compare = /[!=]==\s*[`"']Bearer|[`"']Bearer [^\n]*[`"'+]\s*[!=]==/;
  const offenders = checkedRoutes()
    .filter((f) => compare.test(readFileSync(f, "utf8")))
    .map((f) => relative(root, f));
  expect(offenders).toEqual([]);
});

it("every route that reads a *_SECRET env checks it with hasBearerSecret", () => {
  // Stripe's webhook secret is verified by the Stripe SDK's signature check.
  const ownVerifier = new Set(["webhooks/stripe/route.ts"]);
  const offenders = checkedRoutes()
    .filter((f) => !ownVerifier.has(relative(root, f)))
    .filter((f) => {
      const src = readFileSync(f, "utf8");
      return /process\.env\.\w*SECRET\b/.test(src) && !src.includes("hasBearerSecret(");
    })
    .map((f) => relative(root, f));
  expect(offenders).toEqual([]);
  // The behavioural matrix above must cover each of them too.
  const secretRoutes = checkedRoutes()
    .filter((f) => !ownVerifier.has(relative(root, f)))
    .filter((f) => /process\.env\.\w*SECRET\b/.test(readFileSync(f, "utf8")))
    .map((f) => relative(root, f).replace(/\/route\.ts$/, ""))
    .sort();
  expect(secretRoutes).toEqual(ROUTES.map((r) => r.name).sort());
});
