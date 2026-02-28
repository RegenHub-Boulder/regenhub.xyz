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
  if (!res.ok) throw new Error(`HA error: ${res.status}`);
  return res.json();
}

export const setUserCode = (slot: number, code: string) =>
  haPost("/script/set_user_code", { entity_id: "script.set_user_code", slot, lock_code: code });

export const clearUserCode = (slot: number) =>
  haPost("/script/clear_user_code", { entity_id: "script.clear_user_code", slot });
