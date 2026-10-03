import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "http://supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
const { expireOldCodes } = await import("./scheduler.js");
const { clearSlotSafely } = await import("@regenhub/shared");

for (const outcome of ["partial", "throw", "success"]) {
  test(`expiry ${outcome}: releases only after all-door clear`, async () => {
    const quarantine = new Set<number>();
    const updates: unknown[] = [];
    const builder = {
      select() { return builder; }, eq() { return builder; }, lt() { return builder; },
      update(value: unknown) { updates.push(value); return builder; },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: [{ id: 1, pin_slot: 101 }], error: null }).then(resolve); },
    };
    const db = {
      from: () => builder,
      async rpc(name: string, args: Record<string, unknown> = {}) {
        if (name === "quarantine_lock_slot") quarantine.add(args.p_slot as number);
        if (name === "release_lock_quarantine") quarantine.delete(args.p_slot as number);
        return { data: true, error: null };
      },
    };
    const result = await expireOldCodes(db as never, slot => clearSlotSafely(slot, async () => {
      if (outcome === "throw") throw new Error("mock timeout");
      return [{ entity: "front", ok: true }, { entity: "back", ok: outcome === "success" }];
    }, ["front", "back"]));
    assert.equal(quarantine.has(101), outcome !== "success");
    assert.equal(updates.length, outcome === "success" ? 1 : 0);
    assert.deepEqual(result, outcome === "success" ? { expired: 1, errors: 0 } : { expired: 0, errors: 1 });
  });
}
