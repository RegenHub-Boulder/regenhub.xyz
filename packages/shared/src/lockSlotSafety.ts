import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LockResult } from "./homeAssistant.js";

// One writer at a time serializes all PIN writers, which keeps allocation and multi-slot edits simple. Since
// migration 070 the reservation is a lease: a live writer renews it every LOCK_WRITER_RENEW_MS while it works, and a
// writer whose lease is older than LOCK_WRITER_LEASE_SECONDS (a process that died mid-operation) is taken over by the
// next acquire, audited. A takeover leaves quarantined slots quarantined, and the dead token fails
// check_lock_writer, which every HA attempt asks first (assertLockWriter), so a writer that wakes up after a
// takeover can't reach a lock. Before 070 runs, renewing is a no-op and the old non-expiring rule holds.
export interface LockDatabase {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/** Must equal `lock_writer_lease_seconds()` in supabase/migrations/070_lock_writer_lease.sql (a test checks). */
export const LOCK_WRITER_LEASE_SECONDS = 120;
export const LOCK_WRITER_RENEW_MS = 20_000;
/** How long an acquire keeps trying before it reports "busy". */
const ACQUIRE_TRIES = 100;
const ACQUIRE_WAIT_MS = 100;

export const LOCK_WRITER_BUSY_MESSAGE = "Another door-code change is running; try again in a minute.";

/** Thrown when another writer held the reservation for the whole acquire window: nothing ran. */
export class LockWriterBusyError extends Error {
  constructor() { super(LOCK_WRITER_BUSY_MESSAGE); this.name = "LockWriterBusyError"; }
}

type Scope = { db: LockDatabase; token: string; owners: Map<number, unknown>; lost: boolean };
const writers = new AsyncLocalStorage<Scope>();

async function rpc(db: LockDatabase, name: string, args: Record<string, unknown> = {}) {
  const result = await db.rpc(name, args);
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  return result.data;
}

/**
 * Note a door-code change that didn't run or broke part-way, for the admin home (migration 070's
 * `record_lock_writer_failure`, an admin_actions row). Best effort: it never throws, so a failure to record can't
 * hide the failure itself.
 */
export async function recordLockWriterFailure(db: LockDatabase, holderLabel: string, error: unknown): Promise<void> {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const result = await db.rpc("record_lock_writer_failure", {
      p_holder_label: holderLabel, p_error: message.slice(0, 300), p_busy: error instanceof LockWriterBusyError,
    });
    if (result.error) console.warn("[LockWriter] couldn't record the failure:", result.error.message);
  } catch (recordError) {
    console.warn("[LockWriter] couldn't record the failure:", recordError);
  }
}

export async function withLockWriter<T>(db: LockDatabase, work: () => Promise<T>, holderLabel = "PIN writer"): Promise<T> {
  if (writers.getStore()) return work();
  const token = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < ACQUIRE_TRIES; attempt++) {
    if (await rpc(db, "acquire_lock_writer", { p_token: token, p_holder_label: holderLabel })) { acquired = true; break; }
    await new Promise(resolve => setTimeout(resolve, ACQUIRE_WAIT_MS));
  }
  if (!acquired) {
    const busy = new LockWriterBusyError();
    await recordLockWriterFailure(db, holderLabel, busy);
    throw busy;
  }
  const scope: Scope = { db, token, owners: new Map(), lost: false };
  // Heartbeat: keep the lease fresh while the work runs, so a slow but live writer is never taken over.
  let warned = false;
  const heartbeat = setInterval(() => {
    Promise.resolve(db.rpc("renew_lock_writer", { p_token: token })).then(result => {
      // Before migration 070 the function doesn't exist; the 053 reservation doesn't expire, so nothing is lost.
      if (result.error) { if (!warned) console.warn("[LockWriter] lease renew failed:", result.error.message); warned = true; return; }
      if (result.data === false) scope.lost = true;
    }, error => { if (!warned) console.warn("[LockWriter] lease renew failed:", error); warned = true; });
  }, LOCK_WRITER_RENEW_MS);
  heartbeat.unref?.();
  return writers.run(scope, async () => {
    try { return await work(); }
    finally {
      clearInterval(heartbeat);
      await rpc(db, "release_lock_writer", { p_token: token });
    }
  });
}

export function lockWriterFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const scope = writers.getStore();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (scope) headers.set("x-lock-writer-token", scope.token);
  return fetch(input, { ...init, headers });
}

export async function assertLockWriter(slot?: number) {
  const scope = writers.getStore();
  if (!scope) throw new Error("Door-code write requires withLockWriter");
  if (scope.lost || !await rpc(scope.db, "check_lock_writer", { p_token: scope.token })) {
    throw new Error("Door-code writer reservation lost");
  }
  if (slot !== undefined) {
    const current = await rpc(scope.db, "lock_slot_owner", { p_token: scope.token, p_slot: slot });
    if (scope.owners.has(slot) && scope.owners.get(slot) !== current) throw new Error("PIN slot owner changed; stale HA write aborted");
    scope.owners.set(slot, current);
  }
}

export async function quarantinedSlots(): Promise<Set<number>> {
  const scope = writers.getStore();
  if (!scope) throw new Error("Slot allocation requires withLockWriter");
  const rows = await rpc(scope.db, "list_lock_quarantines") as { slot: number }[];
  return new Set(rows.map(row => row.slot));
}

export async function quarantineSlot(slot: number, reason: string, results: LockResult[] = []) {
  const scope = writers.getStore();
  if (!scope) throw new Error("Quarantine requires withLockWriter");
  await rpc(scope.db, "quarantine_lock_slot", {
    p_token: scope.token, p_slot: slot, p_reason: reason, p_door_results: results,
  });
}

export async function clearSlotSafely(
  slot: number, clear: () => Promise<LockResult[]>, entities: string[],
): Promise<LockResult[]> {
  await assertLockWriter(slot);
  // Persist before transport, including the crash/unknown-outcome window.
  await quarantineSlot(slot, "Clear in progress or interrupted");
  let results: LockResult[] = [];
  try {
    results = await clear();
    if (!entities.length || entities.some(entity => !results.some(r => r.entity === entity && r.ok && !r.warning))) {
      throw new Error("Clear not confirmed on every configured door; slot quarantined");
    }
  } catch (error) {
    await quarantineSlot(slot, error instanceof Error ? error.message : "Clear threw; outcome unknown", results);
    throw error;
  }
  const scope = writers.getStore()!;
  await rpc(scope.db, "release_lock_quarantine", { p_token: scope.token, p_slot: slot });
  return results;
}

/** A clean initial SET removes only its own interrupted-write marker. */
export async function finishSlotSet(slot: number) {
  const scope = writers.getStore()!;
  await rpc(scope.db, "finish_lock_slot_set", { p_token: scope.token, p_slot: slot });
}
