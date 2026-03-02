/**
 * Home Assistant integration
 * Same logic as door-manager/helpers/homeAssistant.js, now in TypeScript
 */

const HA_URL = process.env.HA_URL!;
const HA_TOKEN = process.env.HA_TOKEN!;

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
    throw new Error(`Home Assistant error: ${res.status} ${await res.text()}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const HA_LOCK_ENTITY = process.env.HA_LOCK_ENTITY ?? "lock.front_door_lock";

export async function setUserCode(slot: number, code: string) {
  return haPost("/services/zwave_js/set_lock_usercode", {
    entity_id: HA_LOCK_ENTITY,
    code_slot: slot,
    usercode: String(code),
  });
}

export async function clearUserCode(slot: number) {
  return haPost("/services/zwave_js/clear_lock_usercode", {
    entity_id: HA_LOCK_ENTITY,
    code_slot: slot,
  });
}
