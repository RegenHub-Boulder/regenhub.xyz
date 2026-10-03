import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LockResult } from "./homeAssistant.js";

// Deliberately non-expiring: a paused worker must never outlive a takeover.
// Serializing all PIN writers keeps allocation and multi-slot edits simple.
export interface LockDatabase {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
const writers = new AsyncLocalStorage<{ db: LockDatabase; token: string; owners: Map<number, unknown> }>();

async function rpc(db: LockDatabase, name: string, args: Record<string, unknown> = {}) {
  const result = await db.rpc(name, args);
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  return result.data;
}

export async function withLockWriter<T>(db: LockDatabase, work: () => Promise<T>, holderLabel = "PIN writer"): Promise<T> {
  if (writers.getStore()) return work();
  const token = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await rpc(db, "acquire_lock_writer", { p_token: token, p_holder_label: holderLabel })) { acquired = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!acquired) throw new Error("Door-code writer busy; retry later. A stopped writer requires operator recovery.");
  return writers.run({ db, token, owners: new Map() }, async () => {
    try { return await work(); }
    finally { await rpc(db, "release_lock_writer", { p_token: token }); }
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
  if (!await rpc(scope.db, "check_lock_writer", { p_token: scope.token })) {
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
