import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePgDb, type PgDb } from "../../../../../test/pgDb";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => ({ id: "admin" })) }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@regenhub/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@regenhub/shared")>(),
  clearUserCode: vi.fn(),
}));

import { POST } from "./route";
import { createServiceClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/admin";
import { clearSlotSafely, clearUserCode } from "@regenhub/shared";
import type { ClearLine } from "@/lib/lockQuarantine";

const DEAD = "00000000-0000-4000-8000-00000000dead";
const doors = ["lock.front_door_lock", "lock.back_door_lock"];
let db: PgDb;
let inFlight = 0;
let maxInFlight = 0;
const order: number[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  inFlight = 0; maxInFlight = 0; order.length = 0;
  db = await makePgDb();
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  // Home Assistant stubbed: the real quarantine bookkeeping, a fake lock that takes a moment and counts overlap.
  vi.mocked(clearUserCode).mockImplementation((slot) => clearSlotSafely(slot, async () => {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); order.push(slot);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return doors.map((entity) => ({ entity, ok: slot !== 104 || entity !== "lock.back_door_lock" }));
  }, doors));
  // 11-23 as it was: a Web PIN writer that died three days ago, and guest slots 101–105 quarantined.
  await db.exec(`insert into lock_slot_writer (id, token, holder_label, acquired_at, renewed_at)
    values (1, '${DEAD}', 'Web PIN writer', now() - interval '3 days', now() - interval '3 days');
    insert into lock_slot_quarantine (slot, reason) select s, 'SET threw or timed out; clear required before reuse' from generate_series(101, 105) s;`);
});
afterEach(async () => { await db.close(); });

async function clear(body: unknown): Promise<{ status: number; lines: ClearLine[] }> {
  const res = await POST(new Request("http://localhost/api/admin/lock-quarantine", { method: "POST", body: JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, lines: text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ClearLine) };
}

describe("POST /api/admin/lock-quarantine", () => {
  it("Clear all takes over the dead writer once and clears every slot one at a time, never 'busy'", async () => {
    const rpc = vi.spyOn(db, "rpc");
    const { status, lines } = await clear({ slots: [101, 102, 103, 104, 105] });
    expect(status).toBe(200);
    expect(lines).toEqual([
      { slot: 101, ok: true, message: "cleared on every lock and released" },
      { slot: 102, ok: true, message: "cleared on every lock and released" },
      { slot: 103, ok: true, message: "cleared on every lock and released" },
      { slot: 104, ok: false, message: "a lock didn't confirm the clear; the slot stays in quarantine" },
      { slot: 105, ok: true, message: "cleared on every lock and released" },
      { done: true },
    ]);
    expect(order).toEqual([101, 102, 103, 104, 105]);
    expect(maxInFlight).toBe(1);
    // One writer scope for the whole batch.
    expect(rpc.mock.calls.filter(([name]) => name === "acquire_lock_writer")).toHaveLength(1);
    expect(rpc.mock.calls.filter(([name]) => name === "release_lock_writer")).toHaveLength(1);
    expect(await db.sql("select slot from lock_slot_quarantine")).toEqual([{ slot: 104 }]);
    expect(await db.sql("select action from admin_actions order by id")).toEqual([{ action: "lock_writer_taken_over" }]);
    expect(await db.sql("select * from lock_slot_writer")).toHaveLength(0);
  });

  it("takes a slot off its holder only when every lock confirmed the clear", async () => {
    // Member slot 12 (lock threw) and guest slot 103 (cleared), each held by someone.
    await db.exec(`insert into lock_slot_writer (id, token) values (1, '00000000-0000-4000-8000-000000000001') on conflict (id) do update set token = excluded.token, renewed_at = now();
      delete from lock_slot_quarantine where slot = 103;
      select set_config('request.headers', '{"x-lock-writer-token":"00000000-0000-4000-8000-000000000001"}', false);
      insert into members (id, name, member_type, pin_code_slot, pin_code) values (7, 'Pat Example', 'hot_desk', 12, '482913');
      insert into day_codes (id, code, pin_slot, is_active, expires_at) values (9, '123456', 103, true, now() + interval '1 day');
      select set_config('request.headers', '{}', false);
      delete from lock_slot_writer;
      insert into lock_slot_quarantine (slot, reason) values (12, 'SET incomplete; clear required before reuse'), (103, 'SET incomplete; clear required before reuse');`);
    vi.mocked(clearUserCode).mockImplementationOnce((slot) => clearSlotSafely(slot, async () => { throw new Error("HA timeout"); }, doors));
    const { lines } = await clear({ slots: [12, 103] });
    expect(lines.slice(0, 2)).toEqual([
      { slot: 12, ok: false, message: "a lock didn't confirm the clear; the slot stays in quarantine" },
      { slot: 103, ok: true, message: "cleared on every lock and released" },
    ]);
    expect(await db.sql("select pin_code_slot from members where id = 7")).toEqual([{ pin_code_slot: 12 }]);
    expect(await db.sql("select is_active from day_codes where id = 9")).toEqual([{ is_active: false }]);
    expect((await db.sql<{ slot: number }>("select slot from lock_slot_quarantine order by slot")).map((r) => r.slot)).toEqual([12, 101, 102, 104, 105]);
  });

  it("refuses a non-admin before any lock I/O", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(null as never);
    expect((await clear({ slots: [101] })).status).toBe(403);
    expect(clearUserCode).not.toHaveBeenCalled();
  });

  it("a slot already out of quarantine is reported, not cleared", async () => {
    const { lines } = await clear({ slots: [42] });
    expect(lines[0]).toEqual({ slot: 42, ok: true, message: "already out of quarantine" });
    expect(clearUserCode).not.toHaveBeenCalled();
  });

  it("a batch that loses the writer part-way stops and says so, recorded once", async () => {
    // After slot 101 the batch stalls past its lease and another writer takes over.
    vi.mocked(clearUserCode).mockImplementationOnce(async (slot) => {
      const out = await clearSlotSafely(slot, async () => doors.map((entity) => ({ entity, ok: true })), doors);
      await db.exec("update lock_slot_writer set token = '00000000-0000-4000-8000-0000000000ff', holder_label = 'Bot PIN writer'");
      return out;
    });
    const { lines } = await clear({ slots: [101, 102, 103] });
    expect(lines).toEqual([
      { slot: 101, ok: true, message: "cleared on every lock and released" },
      { slot: 102, ok: false, message: "not tried: the door-code writer was lost part-way. Try again in a minute." },
      { slot: 103, ok: false, message: "not tried: the door-code writer was lost part-way. Try again in a minute." },
      { done: true },
    ]);
    expect(clearUserCode).toHaveBeenCalledTimes(1);
    expect(await db.sql("select count(*)::int n from admin_actions where action = 'lock_writer_failed'")).toEqual([{ n: 1 }]);
    // The new holder keeps its lease.
    expect(await db.sql("select holder_label from lock_slot_writer")).toEqual([{ holder_label: "Bot PIN writer" }]);
  });

  it("a single slot still works ({ slot })", async () => {
    const { lines } = await clear({ slot: 102 });
    expect(lines).toEqual([{ slot: 102, ok: true, message: "cleared on every lock and released" }, { done: true }]);
  });

  it("rejects a bad slot list before touching the writer", async () => {
    expect((await clear({ slots: [101, 0] })).status).toBe(400);
    expect((await clear({ slots: [] })).status).toBe(400);
    expect(await db.sql("select holder_label from lock_slot_writer")).toEqual([{ holder_label: "Web PIN writer" }]);
  });

  it("a live writer answers one plain 'busy' line and nothing runs", async () => {
    await db.exec("update lock_slot_writer set renewed_at = now()");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const pending = clear({ slots: [101, 102] });
      await vi.advanceTimersByTimeAsync(100 * 100);
      const { lines } = await pending;
      expect(lines).toEqual([{ error: "Another door-code change is running; try again in a minute." }]);
    } finally { vi.useRealTimers(); }
    expect(order).toEqual([]);
    expect(await db.sql("select count(*)::int n from lock_slot_quarantine")).toEqual([{ n: 5 }]);
  });
});
