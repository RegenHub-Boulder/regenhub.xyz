/**
 * Home Assistant integration — Z-Wave lock control
 *
 * Targets all locks in HA_LOCK_ENTITIES (comma-separated entity IDs).
 * Uses Promise.allSettled + per-lock retries so one flaky lock
 * doesn't block the entire operation.
 */

const HA_URL = process.env.HA_URL!;
const HA_TOKEN = process.env.HA_TOKEN!;

// Comma-separated list of Z-Wave lock entity IDs to target.
// e.g. HA_LOCK_ENTITIES=lock.front_door_lock,lock.back_door_lock
const LOCK_ENTITIES = (process.env.HA_LOCK_ENTITIES ?? "lock.front_door_lock")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

/** Retry a single HA call with exponential backoff (1s, 2s). */
async function haPostWithRetry(
  endpoint: string,
  data: Record<string, unknown>,
  retries = 2
): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await haPost(endpoint, data);
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

/**
 * Set a user code on all locks. Uses allSettled so one flaky lock
 * doesn't block the other. Retries each lock up to 2 times.
 *
 * - If ALL locks fail → throws (nothing worked).
 * - If some fail → returns LockResult[] with partial success.
 * - If all succeed → returns LockResult[] with all ok.
 */
export async function setUserCode(slot: number, code: string): Promise<LockResult[]> {
  const results = await Promise.allSettled(
    LOCK_ENTITIES.map((entity) =>
      haPostWithRetry("/services/zwave_js/set_lock_usercode", {
        entity_id: entity,
        code_slot: slot,
        usercode: String(code),
      })
    )
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
    LOCK_ENTITIES.map((entity) =>
      haPostWithRetry("/services/zwave_js/clear_lock_usercode", {
        entity_id: entity,
        code_slot: slot,
      })
    )
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

/** Human-readable summary of which locks had issues. */
export function formatLockWarning(results: LockResult[]): string | null {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  const names = failed.map((r) => r.entity.replace("lock.", "").replace(/_/g, " ")).join(", ");
  return `${names} didn't respond — code may not work on ${failed.length === 1 ? "that door" : "those doors"}`;
}
