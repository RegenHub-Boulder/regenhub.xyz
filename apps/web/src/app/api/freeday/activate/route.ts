import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  setUserCode,
  formatLockWarning,
  generateRandomCode,
  DAY_CODE_SLOT_MIN,
  DAY_CODE_SLOT_MAX,
} from "@regenhub/shared";

const TIMEZONE = process.env.TIMEZONE ?? "America/Denver";

/** Get today's date as YYYY-MM-DD in Mountain Time */
function getTodayMountain(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // en-CA gives YYYY-MM-DD
}

/** Calculate 6 PM Mountain Time today (free day passes end at 6 PM) */
function calculateFreeDayExpiration(): Date {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const year = parseInt(parts.find((p) => p.type === "year")!.value);
  const month = parseInt(parts.find((p) => p.type === "month")!.value);
  const day = parseInt(parts.find((p) => p.type === "day")!.value);

  // Build 6 PM local time via UTC offset calculation
  const guess = new Date(Date.UTC(year, month - 1, day, 18, 0, 0));
  const localStr = guess.toLocaleString("en-US", { timeZone: TIMEZONE });
  const localAsUtc = new Date(localStr);
  const offsetMs = guess.getTime() - localAsUtc.getTime();
  const exp = new Date(guess.getTime() + offsetMs);

  if (exp <= now) {
    // Already past 6 PM — expire tomorrow at 6 PM
    return new Date(exp.getTime() + 24 * 60 * 60 * 1000);
  }
  return exp;
}

/** Find the next available day code slot (101-200) */
async function findAvailableSlot(
  supabase: ReturnType<typeof createServiceClient>
): Promise<number | null> {
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

/** Post activation notification to Telegram */
async function notifyTelegram(name: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;

  const lines = [
    `🔓 *Free Day Activated*`,
    ``,
    `*${name}* just got their free day code!`,
  ];

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error("[FreeDay] Telegram activation notify error:", err);
  }
}

export async function POST() {
  // Require authentication
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createServiceClient();

  // Find user's claim (by supabase_user_id or email fallback)
  let { data: claim } = await admin
    .from("free_day_claims")
    .select("*")
    .eq("supabase_user_id", user.id)
    .single();

  if (!claim && user.email) {
    const { data: emailClaim } = await admin
      .from("free_day_claims")
      .select("*")
      .eq("email", user.email)
      .is("supabase_user_id", null)
      .single();

    if (emailClaim) {
      await admin
        .from("free_day_claims")
        .update({ supabase_user_id: user.id })
        .eq("id", emailClaim.id);
      claim = { ...emailClaim, supabase_user_id: user.id };
    }
  }

  if (!claim) {
    return NextResponse.json(
      { error: "No free day claim found. Visit /freeday to claim yours." },
      { status: 404 }
    );
  }

  // Already activated — return the existing code
  if (claim.status === "activated" && claim.day_code_id) {
    const { data: existingCode } = await admin
      .from("day_codes")
      .select("code, expires_at")
      .eq("id", claim.day_code_id)
      .single();

    if (existingCode) {
      return NextResponse.json({
        code: existingCode.code,
        expires_at: existingCode.expires_at,
        lock_warning: null,
        already_activated: true,
      });
    }
  }

  if (claim.status !== "reserved") {
    return NextResponse.json(
      { error: "This claim cannot be activated" },
      { status: 400 }
    );
  }

  // Check date: claimed_date must be today (Mountain Time)
  const today = getTodayMountain();
  if (claim.claimed_date !== today) {
    const dateStr = new Date(
      claim.claimed_date + "T12:00:00"
    ).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    return NextResponse.json(
      {
        error: `Your free day is reserved for ${dateStr}. Come back then to get your code!`,
      },
      { status: 400 }
    );
  }

  // Find available slot
  const slot = await findAvailableSlot(admin);
  if (!slot) {
    return NextResponse.json(
      {
        error:
          "All temporary door code slots are in use right now. Please try again in a bit.",
      },
      { status: 503 }
    );
  }

  const code = generateRandomCode();
  const expiresAt = calculateFreeDayExpiration();

  // Set code on the physical locks
  let lockWarning: string | null = null;
  try {
    const lockResults = await setUserCode(slot, code);
    lockWarning = formatLockWarning(lockResults);
  } catch (err) {
    console.error("[FreeDay] Lock error:", err);
    return NextResponse.json(
      {
        error:
          "Couldn't reach the door locks. This is usually temporary — try again in a moment.",
      },
      { status: 502 }
    );
  }

  // Insert day_code record
  const { data: dayCode, error: insertError } = await admin
    .from("day_codes")
    .insert({
      day_pass_id: null,
      member_id: null,
      label: `Free Day: ${claim.name}`,
      code,
      pin_slot: slot,
      issued_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      is_active: true,
    })
    .select("id")
    .single();

  if (insertError || !dayCode) {
    console.error("[FreeDay] DB insert error:", insertError);
    return NextResponse.json(
      { error: "Code set on lock but database save failed" },
      { status: 500 }
    );
  }

  // Update claim status
  await admin
    .from("free_day_claims")
    .update({
      status: "activated",
      day_code_id: dayCode.id,
      activated_at: new Date().toISOString(),
    })
    .eq("id", claim.id);

  // Notify Telegram (fire-and-forget)
  notifyTelegram(claim.name);

  return NextResponse.json({
    code,
    expires_at: expiresAt.toISOString(),
    lock_warning: lockWarning,
  });
}
