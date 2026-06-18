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
  /**
   * Set when HA accepted the command (ok = true) but the lock's cached health
   * suggests the change may NOT have actually landed — e.g. low battery or a
   * flapping node. Lets callers warn the user instead of showing a false green
   * check. See lockHealthWarning().
   */
  warning?: string;
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
 * Best-effort detector for SILENT lock-write failures.
 *
 * HA's set_lock_usercode / clear_lock_usercode return HTTP 200 the moment the
 * lock's Z-Wave radio ACKs the command — BEFORE the lock commits the change to
 * memory. On a low-battery or flapping node the radio can ACK (cheap) while the
 * EEPROM write (expensive) silently fails, so the change never takes and we'd
 * otherwise report success. We read the node's status + battery alarm from HA's
 * cache (NO Z-Wave radio traffic) and return a human warning if either looks
 * bad, so callers can say "may not have applied — test it" instead of a false
 * green check.
 *
 * Returns undefined when the lock looks healthy, OR when the health sensors
 * aren't present (we don't second-guess a 200 we can't corroborate). Naming
 * follows Z-Wave JS defaults: lock.<base> -> sensor.<base>_node_status,
 * binary_sensor.<base>_replace_battery_now.
 */
async function lockHealthWarning(lockEntity: string): Promise<string | undefined> {
  const base = lockEntity.replace(/^lock\./, "");
  const [nodeStatus, batteryLow] = await Promise.all([
    getEntityState(`sensor.${base}_node_status`),
    getEntityState(`binary_sensor.${base}_replace_battery_now`),
  ]);
  if (batteryLow === "on") return "is low on battery — the change may not have applied";
  if (nodeStatus && nodeStatus !== "alive") return `was ${nodeStatus} on the mesh — the change may not have applied`;
  return undefined;
}

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

  const lockResults: LockResult[] = await Promise.all(
    results.map(async (r, i) => {
      const entity = LOCK_ENTITIES[i];
      if (r.status === "rejected") {
        return { entity, ok: false, error: String(r.reason) };
      }
      // HTTP 200 only means HA accepted the command — corroborate against the
      // node's cached health so a low-battery silent failure surfaces a warning.
      const warning = await lockHealthWarning(entity);
      if (warning) console.warn(`[Lock] ${entity} accepted code for slot ${slot} but ${warning}`);
      return { entity, ok: true, warning };
    })
  );

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

  const lockResults: LockResult[] = await Promise.all(
    results.map(async (r, i) => {
      const entity = LOCK_ENTITIES[i];
      if (r.status === "rejected") {
        return { entity, ok: false, error: String(r.reason) };
      }
      // A silently-failed CLEAR is worse than a failed set — the revoked code
      // would still open the door. Flag suspect node health so it gets verified.
      const warning = await lockHealthWarning(entity);
      if (warning) console.warn(`[Lock] ${entity} accepted clear for slot ${slot} but ${warning}`);
      return { entity, ok: true, warning };
    })
  );

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

/**
 * Human-readable summary of per-lock results. Always returns a string.
 *
 * Three buckets: hard failures (HA rejected the command), suspect successes
 * (HA accepted but the node's health says it may not have landed — see
 * lockHealthWarning), and clean successes. A suspect success is NOT silently
 * treated as "set" — that's the whole point of this function post-hardening.
 */
export function formatLockStatus(results: LockResult[]): string {
  const failed = results.filter((r) => !r.ok);
  const suspect = results.filter((r) => r.ok && r.warning);
  const clean = results.filter((r) => r.ok && !r.warning);

  if (failed.length === 0 && suspect.length === 0) {
    return `Code set on ${clean.map((r) => lockName(r.entity)).join(" and ")}`;
  }

  const parts: string[] = [];
  if (failed.length > 0) {
    const names = failed.map((r) => lockName(r.entity)).join(", ");
    parts.push(`${names} didn't respond — code may not work on ${failed.length === 1 ? "that door" : "those doors"}.`);
  }
  for (const r of suspect) {
    parts.push(`${lockName(r.entity)} ${r.warning} — please test it.`);
  }
  if (clean.length > 0) {
    parts.push(`${clean.map((r) => lockName(r.entity)).join(", ")} is set.`);
  }
  parts.push(`If a code doesn't work, contact ${SUPPORT_CONTACT}.`);
  return parts.join(" ");
}

/** @deprecated Use formatLockStatus instead. Kept for backward compat. */
export function formatLockWarning(results: LockResult[]): string | null {
  const failed = results.filter((r) => !r.ok);
  const suspect = results.filter((r) => r.ok && r.warning);
  if (failed.length === 0 && suspect.length === 0) return null;

  const parts: string[] = [];
  if (failed.length > 0) {
    const names = failed.map((r) => lockName(r.entity)).join(", ");
    parts.push(`${names} didn't respond — code may not work on ${failed.length === 1 ? "that door" : "those doors"}.`);
  }
  for (const r of suspect) {
    parts.push(`${lockName(r.entity)} ${r.warning} — please verify.`);
  }
  parts.push(`Contact ${SUPPORT_CONTACT} if the code doesn't work.`);
  return parts.join(" ");
}

/** Error message for total lock failure (all locks unreachable). */
export const LOCK_FAILURE_MSG = `Couldn't reach the door locks after multiple attempts. This is usually temporary — try again in a few minutes. If it keeps happening, contact ${SUPPORT_CONTACT}.`;

export { SUPPORT_CONTACT };

// ── Door hold-open support (happy hours etc) ────────────────

/** Resolve "front" / "back" / "both" to entity IDs from HA_LOCK_ENTITIES. */
export function resolveDoorEntities(which: "front" | "back" | "both"): string[] {
  if (which === "both") return [...LOCK_ENTITIES];
  return LOCK_ENTITIES.filter((e) => e.includes(which));
}

/** All configured lock entity IDs. */
export function getLockEntities(): string[] {
  return [...LOCK_ENTITIES];
}

/**
 * Unlock specific door(s). Used by the bot's hold-open keep-alive — HA's
 * own auto-lock automation stays untouched and will relock within ~5 min,
 * so callers must re-call this on an interval to HOLD a door open. That's
 * deliberate: if the caller dies, doors fail back to locked.
 */
export async function unlockDoors(entities: string[]): Promise<LockResult[]> {
  const results = await Promise.allSettled(
    entities.map((entity) =>
      haPostWithRetry("/services/lock/unlock", { entity_id: entity }, 1),
    ),
  );
  return results.map((r, i) => ({
    entity: entities[i],
    ok: r.status === "fulfilled",
    error: r.status === "rejected" ? String(r.reason) : undefined,
  }));
}

/** Lock specific door(s). */
export async function lockDoors(entities: string[]): Promise<LockResult[]> {
  const results = await Promise.allSettled(
    entities.map((entity) =>
      haPostWithRetry("/services/lock/lock", { entity_id: entity }, 2),
    ),
  );
  return results.map((r, i) => ({
    entity: entities[i],
    ok: r.status === "fulfilled",
    error: r.status === "rejected" ? String(r.reason) : undefined,
  }));
}

/** Read an entity's state from HA's cache — no Z-Wave radio traffic. */
export async function getEntityState(entityId: string): Promise<string | null> {
  try {
    const res = await fetch(`${HA_URL}/states/${entityId}`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { state?: string };
    return data.state ?? null;
  } catch {
    return null;
  }
}

/** Turn an HA automation on/off (used to suspend auto-lock during door holds). */
export async function setAutomationEnabled(entityId: string, enabled: boolean): Promise<boolean> {
  try {
    await haPost(`/services/automation/turn_${enabled ? "on" : "off"}`, { entity_id: entityId });
    return true;
  } catch (err) {
    console.error(`[HA] automation turn_${enabled ? "on" : "off"} failed:`, err);
    return false;
  }
}

/** The auto-lock automation entity. Override via AUTO_LOCK_AUTOMATION_ENTITY. */
export function autoLockAutomationEntity(): string {
  return process.env.AUTO_LOCK_AUTOMATION_ENTITY ?? "automation.auto_lock_doors_after_5_minutes";
}
