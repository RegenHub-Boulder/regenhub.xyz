/**
 * Home Assistant integration — Z-Wave lock control
 *
 * Targets all locks in HA_LOCK_ENTITIES (comma-separated entity IDs).
 * Uses Promise.allSettled + per-lock retries so one flaky lock
 * doesn't block the entire operation. After initial set, sends a
 * verification re-send to improve reliability on Z-Wave mesh.
 */

const HA_URL = process.env.HA_URL!;
const HA_TOKEN = process.env.HA_TOKEN!;

// Comma-separated list of Z-Wave lock entity IDs to target.
// e.g. HA_LOCK_ENTITIES=lock.front_door_lock,lock.back_door_lock
const LOCK_ENTITIES = (process.env.HA_LOCK_ENTITIES ?? "lock.front_door_lock")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SUPPORT_CONTACT = "@UnforcedAG on Telegram";

export type LockResult = {
  entity: string;
  ok: boolean;
  error?: string;
};

async function haPost(endpoint: string, data: Record<string, unknown>) {
  const res = await fetch(`${HA_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HA ${res.status}: ${body || "(no body)"}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Retry a single HA call with exponential backoff (1s, 2s, 4s). */
async function haPostWithRetry(
  endpoint: string,
  data: Record<string, unknown>,
  retries = 3
): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await haPost(endpoint, data);
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Set a user code on all locks. For each lock:
 *   1. Send the set command (with retries)
 *   2. Wait 3 seconds for Z-Wave mesh to propagate
 *   3. Send the command again as a verification re-send
 *
 * - If ALL locks fail -> throws (nothing worked).
 * - If some fail -> returns LockResult[] with partial success.
 * - If all succeed -> returns LockResult[] with all ok.
 */
export async function setUserCode(slot: number, code: string): Promise<LockResult[]> {
  const payload = {
    entity_id: "",
    code_slot: slot,
    usercode: String(code),
  };

  const results = await Promise.allSettled(
    LOCK_ENTITIES.map(async (entity) => {
      const data = { ...payload, entity_id: entity };
      // Initial set with retries
      await haPostWithRetry("/services/zwave_js/set_lock_usercode", data);
      // Wait for Z-Wave mesh propagation, then re-send for reliability
      await sleep(3000);
      await haPostWithRetry("/services/zwave_js/set_lock_usercode", data, 1);
    })
  );

  const lockResults: LockResult[] = results.map((r, i) => ({
    entity: LOCK_ENTITIES[i],
    ok: r.status === "fulfilled",
    error: r.status === "rejected" ? String(r.reason) : undefined,
  }));

  if (lockResults.every((r) => !r.ok)) {
    throw new Error(
      `All locks failed: ${lockResults.map((r) => `${r.entity}: ${r.error}`).join("; ")}`
    );
  }

  return lockResults;
}

/**
 * Clear a user code from all locks. Same resilience pattern as setUserCode.
 */
export async function clearUserCode(slot: number): Promise<LockResult[]> {
  const results = await Promise.allSettled(
    LOCK_ENTITIES.map(async (entity) => {
      const data = { entity_id: entity, code_slot: slot };
      await haPostWithRetry("/services/zwave_js/clear_lock_usercode", data);
      await sleep(3000);
      await haPostWithRetry("/services/zwave_js/clear_lock_usercode", data, 1);
    })
  );

  const lockResults: LockResult[] = results.map((r, i) => ({
    entity: LOCK_ENTITIES[i],
    ok: r.status === "fulfilled",
    error: r.status === "rejected" ? String(r.reason) : undefined,
  }));

  if (lockResults.every((r) => !r.ok)) {
    throw new Error(
      `All locks failed: ${lockResults.map((r) => `${r.entity}: ${r.error}`).join("; ")}`
    );
  }

  return lockResults;
}

/** Human-readable lock name from entity ID. */
function lockName(entity: string): string {
  return entity.replace("lock.", "").replace(/_/g, " ");
}

/** Human-readable summary of per-lock results. Always returns a string (success or warning). */
export function formatLockStatus(results: LockResult[]): string {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0) {
    return `Code set on ${ok.map((r) => lockName(r.entity)).join(" and ")}`;
  }

  const failedNames = failed.map((r) => lockName(r.entity)).join(", ");
  const okNames = ok.map((r) => lockName(r.entity)).join(", ");
  let msg = `${failedNames} didn't respond — code may not work on ${failed.length === 1 ? "that door" : "those doors"}.`;
  if (ok.length > 0) msg += ` ${okNames} is set.`;
  msg += ` If the code doesn't work, contact ${SUPPORT_CONTACT}.`;
  return msg;
}

/** @deprecated Use formatLockStatus instead. Kept for backward compat. */
export function formatLockWarning(results: LockResult[]): string | null {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  const names = failed.map((r) => lockName(r.entity)).join(", ");
  return `${names} didn't respond — code may not work on ${failed.length === 1 ? "that door" : "those doors"}. Contact ${SUPPORT_CONTACT} if the code doesn't work.`;
}

/** Error message for total lock failure (all locks unreachable). */
export const LOCK_FAILURE_MSG = `Couldn't reach the door locks after multiple attempts. This is usually temporary — try again in a few minutes. If it keeps happening, contact ${SUPPORT_CONTACT}.`;

export { SUPPORT_CONTACT };
