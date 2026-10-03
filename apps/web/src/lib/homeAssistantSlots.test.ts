import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("HA_URL", "http://ha.invalid");
  vi.stubEnv("HA_TOKEN", "test-only");
  vi.stubEnv("HA_LOCK_ENTITIES", "lock.front,lock.back");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function database() {
  const quarantine = new Map<number, unknown>();
  let owner = "day:1";
  const db = { rpc: vi.fn(async (name: string, params: Record<string, unknown> = {}) => {
    if (name === "lock_slot_owner") return { data: owner, error: null };
    if (name === "list_lock_quarantines") return { data: [...quarantine.keys()].map(slot => ({ slot })), error: null };
    if (name === "quarantine_lock_slot") quarantine.set(params.p_slot as number, params);
    if (["release_lock_quarantine", "finish_lock_slot_set"].includes(name)) quarantine.delete(params.p_slot as number);
    return { data: true, error: null };
  }) };
  return { db, quarantine, changeOwner: () => { owner = "day:2"; } };
}

it.each(["partial", "timeout", "recovered-timeout", "throw", "warning"])("HA %s clear remains quarantined and cannot allocate", async kind => {
  const { clearUserCode, withLockWriter, allocateSlotWithRetry } = await import("../../../../packages/shared/src/index");
  const state = database();
  let backAttempts = 0;
  const request = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes("/states/")) return Response.json({ state: kind === "warning" ? "dead" : "alive" });
    const entity = JSON.parse(options!.body as string).entity_id;
    if (entity === "lock.back") {
      backAttempts++;
      if (kind === "recovered-timeout" && backAttempts === 1) throw new DOMException("Request timed out", "TimeoutError");
      if (kind === "timeout") throw new DOMException("Request timed out", "TimeoutError");
      if (kind === "throw") throw new Error("connection lost");
      if (kind === "partial") return new Response("unavailable", { status: 503 });
    }
    return Response.json([]);
  });
  vi.stubGlobal("fetch", request);
  const operation = withLockWriter(state.db, async () => {
    await expect(clearUserCode(101)).rejects.toThrow();
    const result = await allocateSlotWithRetry({ min: 101, max: 102, getUsedSlots: async () => new Set<number>(),
      tryInsert: async slot => ({ data: { slot }, error: null }),
    });
    expect(result.ok && result.slot).toBe(102);
  });
  await vi.runAllTimersAsync(); await operation;
  expect(state.quarantine.has(101)).toBe(true);
  expect(request.mock.calls.find(([url]) => url.includes("/services/"))?.[1]?.signal).toBeInstanceOf(AbortSignal);
});

it("all configured doors clear, including resends, before releasing", async () => {
  const { clearUserCode, withLockWriter } = await import("../../../../packages/shared/src/index");
  const state = database(); state.quarantine.set(101, {});
  const request = vi.fn(async (url: string) => url.includes("/states/") ? Response.json({ state: "alive" }) : Response.json([]));
  vi.stubGlobal("fetch", request);
  const operation = withLockWriter(state.db, () => clearUserCode(101));
  await vi.runAllTimersAsync(); await operation;
  expect(state.quarantine.has(101)).toBe(false);
  expect(request.mock.calls.filter(([url]) => url.includes("clear_lock_usercode"))).toHaveLength(4);
});

it("ownership change during a resend delay aborts the stale clear before transport", async () => {
  const { clearUserCode, withLockWriter } = await import("../../../../packages/shared/src/index");
  const state = database();
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/services/")) {
      writes++;
      if (writes === 2) state.changeOwner();
    }
    return Response.json([]);
  }));
  const operation = withLockWriter(state.db, async () => { await expect(clearUserCode(101)).rejects.toThrow(); });
  await vi.runAllTimersAsync(); await operation;
  expect(writes).toBe(2);
  expect(state.quarantine.has(101)).toBe(true);
});
