import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePgDb, type PgDb } from "../../test/pgDb";
import {
  LOCK_WRITER_LEASE_SECONDS, LOCK_WRITER_RENEW_MS, clearSlotSafely, quarantinedSlots, withLockWriter,
} from "@regenhub/shared";

/**
 * The door-code writer is a lease (migration 070, T-482). Real Postgres with every migration: a writer that died
 * mid-operation is taken over by the next one and audited, a live writer that renews is never taken over, and a slot
 * the dead writer was mid-setting stays quarantined.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const DEAD = "00000000-0000-4000-8000-00000000dead";
const doors = ["lock.front_door_lock", "lock.back_door_lock"];
const success = doors.map((entity) => ({ entity, ok: true }));
let db: PgDb;

beforeEach(async () => { db = await makePgDb(); });
afterEach(async () => { vi.useRealTimers(); await db.close(); });

/** As a writer that took the reservation `ago` and never renewed it, then stopped mid-SET of `midSet`. */
async function deadWriter(ago: string, { midSet, cleared = [] }: { midSet?: number; cleared?: number[] } = {}) {
  await db.exec(`insert into lock_slot_writer (id, token, holder_label, acquired_at, renewed_at, cleared_slots)
    values (1, '${DEAD}', 'Web PIN writer', now() - interval '${ago}', now() - interval '${ago}', '{${cleared.join(",")}}');`);
  if (midSet) {
    await db.sql("select quarantine_lock_slot($1, $2, 'SET in progress or interrupted', '[]')", [DEAD, midSet]);
  }
}

describe("door-code writer lease (070)", () => {
  it("the lease in code is the lease in SQL", async () => {
    const sql = await readFile(new URL("../../../../supabase/migrations/070_lock_writer_lease.sql", import.meta.url), "utf8");
    expect(sql).toMatch(new RegExp(`lock_writer_lease_seconds\\(\\) returns integer\\s+language sql immutable as \\$\\$ select ${LOCK_WRITER_LEASE_SECONDS} \\$\\$`));
    expect(LOCK_WRITER_RENEW_MS * 4).toBeLessThan(LOCK_WRITER_LEASE_SECONDS * 1000);
  });

  it("takes over a stale lease, audits it, and the dead token stops working", async () => {
    await deadWriter("3 days");
    const ran = await withLockWriter(db, async () => {
      const [row] = await db.sql<{ holder_label: string; cleared_slots: number[] }>("select holder_label, cleared_slots from lock_slot_writer");
      return row;
    }, "Web PIN writer (new)");
    expect(ran.holder_label).toBe("Web PIN writer (new)");
    const audit = await db.sql<{ payload: Record<string, unknown> }>(
      "select payload from admin_actions where action = 'lock_writer_taken_over'");
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ stale_holder: "Web PIN writer", new_holder: "Web PIN writer (new)", lease_seconds: 120 });
    expect((await db.sql("select check_lock_writer($1) ok", [DEAD]))[0].ok).toBe(false);
    // The new writer released on its way out; nothing is left held.
    expect(await db.sql("select * from lock_slot_writer")).toHaveLength(0);
  });

  it("leaves a writer inside its lease alone", async () => {
    await deadWriter("30 seconds");
    expect((await db.rpc("acquire_lock_writer", { p_token: "00000000-0000-4000-8000-000000000002", p_holder_label: "x" })).data).toBe(false);
    expect(await db.sql("select * from admin_actions where action = 'lock_writer_taken_over'")).toHaveLength(0);
  });

  it("a slot the dead writer was mid-setting stays quarantined, and its confirmed clears don't carry over", async () => {
    await db.exec(`insert into lock_slot_writer (id, token) values (1, '${DEAD}');
      select set_config('request.headers', '{"x-lock-writer-token":"${DEAD}"}', false);
      insert into members (id, name, member_type, pin_code_slot, pin_code) values (7, 'Pat Example', 'hot_desk', 12, '482913');
      select set_config('request.headers', '{}', false);
      delete from lock_slot_writer;`);
    await deadWriter("10 minutes", { midSet: 101, cleared: [12] });
    await withLockWriter(db, async () => {
      expect(await quarantinedSlots()).toEqual(new Set([101]));
      // The takeover starts with nothing cleared: releasing slot 12 without a clear of our own quarantines it.
      await db.from("members").update({ pin_code_slot: null, pin_code: null }).eq("id", 7);
    });
    const slots = await db.sql<{ slot: number; reason: string }>("select slot, reason from lock_slot_quarantine order by slot");
    expect(slots).toEqual([
      { slot: 12, reason: "Ownership released without confirmed all-door clear" },
      { slot: 101, reason: "SET in progress or interrupted" },
    ]);
    // Nothing new is allocated into the mid-set slot.
    await withLockWriter(db, async () => {
      const { error } = await db.from("day_codes").insert({ code: "123456", pin_slot: 101, is_active: true, expires_at: new Date().toISOString() });
      expect(error?.message).toMatch(/quarantined/);
    });
  });

  it("a live writer that renews is never taken over, however long it works", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const live = withLockWriter(db, () => gate, "Slow live writer");
    await vi.waitFor(async () => expect(await db.sql("select * from lock_slot_writer")).toHaveLength(1));
    // It has been working for 3 minutes: well past the lease since it took the writer…
    await db.exec("update lock_slot_writer set acquired_at = now() - interval '3 minutes', renewed_at = now() - interval '3 minutes'");
    // …and its heartbeat fires on schedule.
    await vi.advanceTimersByTimeAsync(LOCK_WRITER_RENEW_MS);
    await vi.waitFor(async () => {
      const [row] = await db.sql<{ fresh: boolean }>("select renewed_at > now() - interval '1 minute' fresh from lock_slot_writer");
      expect(row.fresh).toBe(true);
    });
    const other = await db.rpc("acquire_lock_writer", { p_token: "00000000-0000-4000-8000-000000000003", p_holder_label: "Impatient" });
    expect(other.data).toBe(false);
    expect((await db.sql<{ holder_label: string }>("select holder_label from lock_slot_writer"))[0].holder_label).toBe("Slow live writer");
    finish(); await live;
    expect(await db.sql("select * from admin_actions where action = 'lock_writer_taken_over'")).toHaveLength(0);
  });

  it("a writer that wakes after a takeover can't reach a lock or free the new holder", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const transport = vi.fn(async () => success);
    const frozen = withLockWriter(db, async () => {
      await gate;
      await clearSlotSafely(101, transport, doors);
    }, "Frozen writer");
    await vi.waitFor(async () => expect(await db.sql("select * from lock_slot_writer")).toHaveLength(1));
    // Frozen (no heartbeat) past the lease; another writer takes over and is still working when it wakes.
    await db.exec("update lock_slot_writer set renewed_at = now() - interval '5 minutes'");
    let release!: () => void;
    const holding = new Promise<void>((resolve) => { release = resolve; });
    const next = withLockWriter(db, () => holding, "Next writer");
    await vi.waitFor(async () => expect((await db.sql<{ holder_label: string }>("select holder_label from lock_slot_writer"))[0]?.holder_label).toBe("Next writer"));
    finish();
    await expect(frozen).rejects.toThrow(/reservation lost/);
    expect(transport).not.toHaveBeenCalled();
    // The woken writer's release didn't free the new holder's lease.
    expect((await db.sql<{ holder_label: string }>("select holder_label from lock_slot_writer"))[0].holder_label).toBe("Next writer");
    release(); await next;
  });

  it("a busy acquire says so plainly and is recorded for the admin home", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await deadWriter("10 seconds");
    const attempt = withLockWriter(db, async () => "ran", "Web PIN writer");
    const outcome = expect(attempt).rejects.toThrow("Another door-code change is running; try again in a minute.");
    await vi.advanceTimersByTimeAsync(100 * 100);
    await outcome;
    const [row] = await db.sql<{ payload: Record<string, unknown> }>("select payload from admin_actions where action = 'lock_writer_failed'");
    expect(row.payload).toMatchObject({ holder: "Web PIN writer", busy: true, held_by: "Web PIN writer" });
  });
});
