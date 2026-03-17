import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setUserCode, formatLockWarning, generateRandomCode, DAY_CODE_SLOT_MIN, DAY_CODE_SLOT_MAX } from "@regenhub/shared";

const TIMEZONE = "America/Denver";

/** Create a Date for a specific local time in Mountain Time. */
function dateAtLocalTime(year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const localStr = guess.toLocaleString("en-US", { timeZone: TIMEZONE });
  const localAsUtc = new Date(localStr);
  const offsetMs = guess.getTime() - localAsUtc.getTime();
  return new Date(guess.getTime() + offsetMs);
}

/** Get today's date parts and day of week in Mountain Time. */
function todayParts(): { year: number; month: number; day: number; dayOfWeek: number } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const year = parseInt(parts.find(p => p.type === "year")!.value);
  const month = parseInt(parts.find(p => p.type === "month")!.value);
  const day = parseInt(parts.find(p => p.type === "day")!.value);
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = weekdayMap[parts.find(p => p.type === "weekday")!.value] ?? 0;
  return { year, month, day, dayOfWeek };
}

/** Calculate 6 PM Mountain Time today (or tomorrow if past 6 PM). */
function calculateDayPassExpiry(): string {
  const now = new Date();
  const { year, month, day } = todayParts();
  const exp = dateAtLocalTime(year, month, day, 18, 0);
  if (exp <= now) {
    exp.setTime(exp.getTime() + 24 * 60 * 60 * 1000);
  }
  return exp.toISOString();
}

async function findAvailableSlot(supabase: Awaited<ReturnType<typeof createClient>>): Promise<number | null> {
  const { data: usedSlots } = await supabase
    .from("day_codes")
    .select("pin_slot")
    .eq("is_active", true);

  const used = new Set(usedSlots?.map((r) => r.pin_slot) ?? []);
  for (let slot = DAY_CODE_SLOT_MIN; slot <= DAY_CODE_SLOT_MAX; slot++) {
    if (!used.has(slot)) return slot;
  }
  return null;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { label, expires_in_hours } = body;

  const { data: member } = await supabase
    .from("members")
    .select("id, member_type, disabled, day_passes_balance")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member || member.disabled) {
    return NextResponse.json({ error: "Account not found or disabled" }, { status: 403 });
  }

  const isFullMember = member.member_type !== "day_pass";

  // Day pass members: enforce 6 PM Mountain Time expiry and block weekends
  let expiresAt: string | null;
  if (isFullMember) {
    // Full members get flexible expiry (as sent by client)
    expiresAt = expires_in_hours == null
      ? null
      : new Date(Date.now() + Math.min(Math.max(Number(expires_in_hours) || 24, 1), 720) * 60 * 60 * 1000).toISOString();
  } else {
    // Day pass members: always expires at 6 PM Mountain Time, block weekends
    const { dayOfWeek } = todayParts();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return NextResponse.json(
        { error: "Day passes are available Monday–Friday. See you next week!" },
        { status: 400 }
      );
    }
    expiresAt = calculateDayPassExpiry();
  }

  // Atomic decrement — prevents double-spend race condition
  const { data: newBalance, error: rpcError } = await supabase.rpc(
    "decrement_day_pass_balance",
    { p_member_id: member.id, p_amount: 1 }
  );

  if (rpcError || newBalance === -1) {
    return NextResponse.json(
      { error: "No day passes remaining — contact an admin to top up" },
      { status: 400 }
    );
  }

  const slot = await findAvailableSlot(supabase);
  if (!slot) {
    // Refund — no slot available
    await supabase.rpc("increment_day_pass_balance", { p_member_id: member.id, p_amount: 1 });
    return NextResponse.json({ error: "No available door code slots" }, { status: 503 });
  }

  const code = generateRandomCode();

  let lockWarning: string | null = null;
  try {
    const lockResults = await setUserCode(slot, code);
    lockWarning = formatLockWarning(lockResults);
  } catch (err) {
    console.error("[Lock] Failed to set day code:", err);
    // Refund — couldn't program lock
    await supabase.rpc("increment_day_pass_balance", { p_member_id: member.id, p_amount: 1 });
    return NextResponse.json(
      { error: "Couldn't reach the door locks. This is usually temporary — try again in a moment." },
      { status: 502 }
    );
  }

  const { error: insertError } = await supabase
    .from("day_codes")
    .insert({
      member_id: member.id,
      label: label ?? null,
      code,
      pin_slot: slot,
      issued_at: new Date().toISOString(),
      expires_at: expiresAt,
      is_active: true,
    });

  if (insertError) {
    console.error("[DB] Failed to insert day code:", insertError);
    return NextResponse.json({ error: "Code set but DB save failed" }, { status: 500 });
  }

  return NextResponse.json({
    code,
    expires_at: expiresAt,
    balance_remaining: newBalance as number,
    lock_warning: lockWarning,
  });
}
