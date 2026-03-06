const HA_URL = process.env.HA_URL!;
const HA_TOKEN = process.env.HA_TOKEN!;

// Comma-separated list of Z-Wave lock entity IDs to target.
// Both locks get the same code set/cleared in parallel.
// e.g. HA_LOCK_ENTITIES=lock.front_door_lock,lock.back_door_lock
const LOCK_ENTITIES = (process.env.HA_LOCK_ENTITIES ?? "lock.front_door_lock")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function haPost(endpoint: string, data: Record<string, unknown>) {
  const res = await fetch(`${HA_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`HA error: ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const setUserCode = (slot: number, code: string) =>
  Promise.all(
    LOCK_ENTITIES.map((entity) =>
      haPost("/services/zwave_js/set_lock_usercode", {
        entity_id: entity,
        code_slot: slot,
        usercode: String(code),
      })
    )
  );

export const clearUserCode = (slot: number) =>
  Promise.all(
    LOCK_ENTITIES.map((entity) =>
      haPost("/services/zwave_js/clear_lock_usercode", {
        entity_id: entity,
        code_slot: slot,
      })
    )
  );
