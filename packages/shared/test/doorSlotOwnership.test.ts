import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateSlotWithRetry } from '../src/slotAllocation.ts';
import { runReservedDoorOperation, type DoorSlotDatabase } from '../src/doorSlotOwnership.ts';

// Synthetic DB contract model, NOT a substitute for PostgreSQL migration tests.
// All doors and device commands below are in-memory; no fetch or HA imports.
class Database implements DoorSlotDatabase {
  generation = 0;
  state = 'free';
  operation = '';
  consumed = new Set<string>();
  quarantineFails = false;
  async rpc(name: string, args: Record<string, unknown>) {
    if (name === 'door_slot_reserve') {
      if (this.state !== 'free' || this.consumed.has(String(args.p_operation))) {
        return { data: null, error: { message: 'Slot unavailable' } };
      }
      this.state = 'pending';
      this.operation = String(args.p_operation);
      this.consumed.add(this.operation);
      return { data: ++this.generation, error: null };
    }
    if (this.quarantineFails) return { data: null, error: { message: 'DB unavailable' } };
    if (args.p_generation !== this.generation || args.p_operation !== this.operation) {
      return { data: null, error: { message: 'Stale door operation' } };
    }
    this.state = 'quarantined';
    return { data: null, error: null };
  }
}
const operation = (id: string) => ({ slot: 101, owner: 'day:1', operation: id, action: 'clear' as const });

test('legacy allocator permits a late clear to erase a new code (retained reproduction)', async () => {
  let physicalCode: string | null = 'old';
  const used = new Set<number>([101]);
  const delayedClear = () => { physicalCode = null; };
  used.delete(101); // legacy row release on HA ACK
  const allocation = await allocateSlotWithRetry({
    min: 101, max: 101, getUsedSlots: async () => used,
    tryInsert: async (slot) => { used.add(slot); return { data: { slot }, error: null }; },
  });
  if (allocation.ok) physicalCode = 'new';
  delayedClear();
  // Opt-in RED probe applies the safety acceptance assertion to the actual
  // legacy allocator; normal runs retain the known unsafe outcome explicitly.
  assert.equal(allocation.ok, process.env.DOOR_SLOT_LEGACY_RED === '1' ? false : true,
    `late clear erased replacement; physicalCode=${physicalCode}`);
  assert.equal(physicalCode, null);
});

test('an acknowledged clear must retain the slot while its device command is live', async () => {
  let physicalCode: string | null = 'old';
  const db = new Database();
  const delayedClear = () => { physicalCode = null; };
  const result = await runReservedDoorOperation(db, operation('old-clear'), async () => {
    assert.equal(db.state, 'pending'); // reservation before HA I/O
    return { accepted: true }; // queued clear has NOT executed
  });
  assert.equal(result.verified, false);
  assert.equal(db.state, 'quarantined');
  let newCommandSent = false;
  await assert.rejects(runReservedDoorOperation(db, operation('new-set'), async () => {
    newCommandSent = true;
    physicalCode = 'new';
  }), /Slot unavailable/);
  delayedClear();
  assert.equal(newCommandSent, false);
  assert.equal(physicalCode, null); // no new owner exposed to delayed command
});

test('overlapping commands cannot dispatch while first command is suspended', async () => {
  const db = new Database();
  let resume!: () => void;
  const pause = new Promise<void>(resolve => { resume = resolve; });
  const first = runReservedDoorOperation(db, operation('first'), async () => pause);
  await Promise.resolve();
  let dispatched = false;
  await assert.rejects(runReservedDoorOperation(db, operation('second'), async () => { dispatched = true; }));
  assert.equal(dispatched, false);
  resume();
  await first;
});

test('timeout or partial clear remains quarantined', async () => {
  const db = new Database();
  await assert.rejects(runReservedDoorOperation(db, operation('timeout'), async () => {
    throw new Error('front ACK; back timed out; command may remain live');
  }), /timed out/);
  assert.equal(db.state, 'quarantined');
  await assert.rejects(runReservedDoorOperation(db, operation('retry'), async () => undefined));
});

test('DB failure after I/O leaves pending and forbids takeover', async () => {
  const db = new Database();
  db.quarantineFails = true;
  await assert.rejects(runReservedDoorOperation(db, operation('first'), async () => true), /remains reserved/);
  assert.equal(db.state, 'pending');
  await assert.rejects(runReservedDoorOperation(db, operation('second'), async () => true), /Slot unavailable/);
});

test('lost reserve response never dispatches or replays the permit', async () => {
  const db = new Database();
  const lost: DoorSlotDatabase = { rpc: async (name, args) => {
    await db.rpc(name, args);
    throw new Error('lost response');
  } };
  let sent = false;
  await assert.rejects(runReservedDoorOperation(lost, operation('first'), async () => { sent = true; }));
  await assert.rejects(runReservedDoorOperation(db, operation('first'), async () => { sent = true; }));
  assert.equal(sent, false);
  assert.equal(db.state, 'pending');
});

test('reservation snapshots identity across awaits and dispatch receives frozen context', async () => {
  const original = operation('original');
  const calls: Record<string, unknown>[] = [];
  const db: DoorSlotDatabase = { rpc: async (name, args) => {
    calls.push(args);
    if (name === 'door_slot_reserve') {
      original.slot = 102;
      original.operation = 'mutated';
      return { data: 1, error: null };
    }
    return { data: null, error: null };
  } };
  await runReservedDoorOperation(db, original, async (context) => {
    assert.equal(Object.isFrozen(context), true);
    assert.equal(context.slot, 101);
    assert.equal(context.operation, 'original');
    assert.equal(context.generation, 1);
    original.slot = 103;
  });
  assert.equal(calls[1].p_slot, 101);
  assert.equal(calls[1].p_operation, 'original');
});
