import { createClient } from "@supabase/supabase-js";
import { telegramIlikePatterns } from "./telegram.js";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

// Service role client — bypasses RLS (bot has full access)
export const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export type MemberRow = {
  id: number;
  name: string;
  email: string | null;
  telegram_username: string | null;
  pin_code: string | null;
  pin_code_slot: number | null;
  member_type: "cold_desk" | "hot_desk" | "hub_friend" | "day_pass";
  is_coop_member: boolean;
  is_admin: boolean;
  disabled: boolean;
  day_passes_balance: number;
  invite_code: string | null;
};

export async function findMemberByTelegram(username: string): Promise<MemberRow | null> {
  const p = telegramIlikePatterns(username);
  if (!p) return null;
  const { data } = await db
    .from("members")
    .select("*")
    .or(`telegram_username.ilike.${p.bare},telegram_username.ilike.${p.withAt}`)
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function findAdminByTelegram(username: string): Promise<MemberRow | null> {
  const member = await findMemberByTelegram(username);
  return member?.is_admin ? member : null;
}
