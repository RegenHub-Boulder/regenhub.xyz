import { describe, expect, it } from "vitest";
import { clearSlotSafely, withLockWriter, quarantinedSlots } from "../../../../packages/shared/src/lockSlotSafety";

function store() {
  let held: string | null = null;
  const quarantine = new Map<number, unknown>();
  return {
    quarantine,
    async rpc(name: string, p: Record<string, unknown>) {
      if (name === "acquire_lock_writer") {
        if (held) return { data: false, error: null };
        held = p.p_token as string;
        return { data: true, error: null };
      }
      if (name === "release_lock_writer") { held = null; return { data: true, error: null }; }
      if (name === "quarantine_lock_slot") quarantine.set(p.p_slot as number, p);
      if (name === "release_lock_quarantine") quarantine.delete(p.p_slot as number);
      if (name === "list_lock_quarantines") return { data: [...quarantine.keys()].map(slot => ({ slot })), error: null };
      return { data: true, error: null };
    },
  };
}
const doors = ["front", "back"];
const success = doors.map(entity => ({ entity, ok: true }));

describe("shared lock slot safety", () => {
  it("quarantines partial clear and excludes it from allocation", async () => {
    const db = store();
    await withLockWriter(db, async () => {
      await expect(clearSlotSafely(101, async () => [success[0], { entity: "back", ok: false }], doors)).rejects.toThrow();
      expect(await quarantinedSlots()).toEqual(new Set([101]));
    });
    expect(db.quarantine.has(101)).toBe(true);
  });
  it.each(["timeout", "throw"])("quarantines %s", async reason => {
    const db = store();
    await withLockWriter(db, async () => {
      await expect(clearSlotSafely(4, async () => { throw new Error(reason); }, doors)).rejects.toThrow(reason);
    });
    expect(db.quarantine.has(4)).toBe(true);
  });
  it("full clear releases quarantine", async () => {
    const db = store(); db.quarantine.set(4, {});
    await withLockWriter(db, () => clearSlotSafely(4, async () => success, doors));
    expect(db.quarantine.size).toBe(0);
  });
  it("admin retry releases only after every configured door succeeds", async () => {
    const db = store(); db.quarantine.set(4, {});
    await withLockWriter(db, async () => {
      await expect(clearSlotSafely(4, async () => [success[0]], doors)).rejects.toThrow();
      expect(db.quarantine.has(4)).toBe(true);
      await clearSlotSafely(4, async () => success, doors);
    });
    expect(db.quarantine.size).toBe(0);
  });
  it("overlapping allocate waits until revoke and its final resend finish", async () => {
    const db = store();
    let resume!: () => void;
    let owner = "old";
    const writes: string[] = [];
    const slow = new Promise<void>(resolve => { resume = resolve; });
    const revoke = withLockWriter(db, async () => {
      await clearSlotSafely(101, async () => {
        writes.push(`clear:${owner}`); await slow; writes.push(`clear:${owner}`); return success;
      }, doors);
      owner = "free";
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const allocate = withLockWriter(db, async () => { owner = "new"; writes.push("set:new"); });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(owner).toBe("old"); resume(); await Promise.all([revoke, allocate]);
    expect(writes).toEqual(["clear:old", "clear:old", "set:new"]);
  });
  it("rejects unguarded HA writes", async () => {
    await expect(clearSlotSafely(101, async () => success, doors)).rejects.toThrow();
  });
});

it("allocator chooses the next slot when the first free business slot is quarantined", async () => {
  const { allocateSlotWithRetry } = await import("../../../../packages/shared/src/slotAllocation");
  const db = store(); db.quarantine.set(101, {});
  await withLockWriter(db, async () => {
    const allocation = await allocateSlotWithRetry({ min: 101, max: 103,
      getUsedSlots: async () => new Set<number>(),
      tryInsert: async slot => ({ data: { id: slot }, error: null }),
    });
    expect(allocation).toEqual({ ok: true, slot: 102, data: { id: 102 } });
  });
});
