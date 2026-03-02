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

export async function setUserCode(slot: number, code: string) {
  return haPost("/services/script/set_user_code", {
    slot,
    lock_code: code,
  });
}

export async function clearUserCode(slot: number) {
  return haPost("/services/script/clear_user_code", { slot });
}
