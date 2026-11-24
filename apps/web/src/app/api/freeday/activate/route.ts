import { withWebLockWriter } from "@/lib/lockWriter";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { codeIssuedSince, codeStillWorks, findClaim, freeDayUsedLine, markClaimUsed, membersByEmail } from "@/lib/freeDayClaim";
import {
  allocateSlotWithRetry,
  setUserCode,
  formatLockStatus,
  generateRandomCode,
  DAY_CODE_SLOT_MIN,
  DAY_CODE_SLOT_MAX,
  LOCK_FAILURE_MSG,
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

/** 6 PM Mountain Time today (a free day ends at 6 PM), or null once it's past. */
function calculateFreeDayExpiration(): Date | null {
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

  // Past 6 PM there is no free day left today: the code is good for that one day only (lib/freeDayRule.ts).
  return exp <= now ? null : exp;
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

  return withWebLockWriter(async () => {
    const admin = createServiceClient();

    const claim = await findClaim(admin, user);

    if (!claim) {
      return NextResponse.json(
        { error: "No free day claim found. Visit /freeday to claim yours." },
        { status: 404 }
      );
    }

    // Already used. The same code back while it still works (a reload on the day); after that, a plain no.
    if (claim.status === "activated") {
      const { data: existingCode } = claim.day_code_id
        ? await admin.from("day_codes").select("code, expires_at, is_active").eq("id", claim.day_code_id).maybeSingle()
        : { data: null };
      if (existingCode && codeStillWorks(existingCode)) {
        return NextResponse.json({
          code: existingCode.code,
          expires_at: existingCode.expires_at,
          lock_status: null,
          already_activated: true,
        });
      }
      return NextResponse.json({ error: freeDayUsedLine(claim.activated_at, false) }, { status: 409 });
    }

    if (claim.status !== "reserved") {
      return NextResponse.json(
        { error: "This claim cannot be activated" },
        { status: 400 }
      );
    }

    // Any weekday, for every claim: an older claim's requested date (claimed_date) no longer holds it to that day.
    const today = getTodayMountain();

    // Both paths still require a weekday — door codes only valid during business hours.
    const todayDayOfWeek = new Date(today + "T12:00:00").getDay(); // 0=Sun, 6=Sat
    if (todayDayOfWeek === 0 || todayDayOfWeek === 6) {
      return NextResponse.json(
        {
          error: "Free days are only available Monday through Friday. Come back during the week!",
        },
        { status: 400 }
      );
    }

    const expiresAt = calculateFreeDayExpiration();
    if (!expiresAt) {
      return NextResponse.json(
        { error: "A free day runs 8 AM to 6 PM. Come back on a weekday and get your code when you arrive." },
        { status: 400 }
      );
    }
    const code = generateRandomCode();

    // The free-day approval trigger (migration 016/036) made (or found) the member row for this email when the claim
    // was approved, and gave it the free day's one pass. Link day_code.member_id to it (else the unlock lands in
    // access_logs as "unattributed") and spend that pass, so /portal/passes can't turn it into a second free day.
    const [linkedMember] = await membersByEmail(admin, claim.email);

    if (linkedMember?.disabled) {
      return NextResponse.json({ error: "Member is disabled" }, { status: 403 });
    }

    let passSpent = false;
    if (linkedMember) {
      const { data: left, error: spendErr } = await admin.rpc("decrement_day_pass_balance", { p_member_id: linkedMember.id, p_amount: 1 });
      if (spendErr || left === -1) {
        // No pass left: it went on a code from Day passes (before the two doors were one). That was the free day.
        const used = linkedMember.member_type === "day_pass" ? await codeIssuedSince(admin, linkedMember.id, claim.created_at) : null;
        if (used) {
          await markClaimUsed(admin, claim.id, used.id, new Date(used.issued_at));
          return NextResponse.json({ error: freeDayUsedLine(used.issued_at, false) }, { status: 409 });
        }
        return NextResponse.json(
          { error: "Your free day pass isn't in your account. Reply to your approval email and we'll sort it out." },
          { status: 409 }
        );
      }
      passSpent = true;
    }
    const refund = async () => {
      if (passSpent) await admin.rpc("increment_day_pass_balance", { p_member_id: linkedMember!.id, p_amount: 1 });
    };

    // Atomic slot claim: INSERT-with-retry against the partial unique index.
    // If a concurrent request claims the chosen slot first, retry with the
    // next free one.
    const allocation = await allocateSlotWithRetry<{ id: number }>({
      min: DAY_CODE_SLOT_MIN,
      max: DAY_CODE_SLOT_MAX,
      getUsedSlots: async () => {
        const { data } = await admin
          .from("day_codes")
          .select("pin_slot")
          .eq("is_active", true);
        return new Set(data?.map((r) => r.pin_slot) ?? []);
      },
      tryInsert: (slot) =>
        admin
          .from("day_codes")
          .insert({
            day_pass_id: null,
            member_id: linkedMember?.id ?? null,
            label: `Free Day: ${claim.name}`,
            code,
            pin_slot: slot,
            issued_at: new Date().toISOString(),
            expires_at: expiresAt.toISOString(),
            is_active: true,
          })
          .select("id")
          .single(),
    });

    if (!allocation.ok) {
      await refund();
      if (!allocation.exhausted) console.error("[FreeDay] DB insert error:", allocation.error);
      return NextResponse.json(
        {
          error: allocation.exhausted
            ? "All temporary door code slots are in use right now. Please try again in a bit."
            : "Code could not be saved",
        },
        { status: allocation.exhausted ? 503 : 500 }
      );
    }

    // Set code on the physical locks
    let lockStatus: string;
    try {
      const lockResults = await setUserCode(allocation.slot, code);
      lockStatus = formatLockStatus(lockResults);
    } catch (err) {
      console.error("[FreeDay] Lock error:", err);
      // End the day_code. Its slot stays quarantined (a lock may hold it) until an admin clears it on Door → Lock
      // Sync; another attempt takes the next free slot.
      await admin
        .from("day_codes")
        .update({ is_active: false, revoked_at: new Date().toISOString() })
        .eq("id", allocation.data.id);
      await refund();
      return NextResponse.json(
        { error: LOCK_FAILURE_MSG },
        { status: 502 }
      );
    }

    await markClaimUsed(admin, claim.id, allocation.data.id);

    // Notify Telegram (fire-and-forget)
    notifyTelegram(claim.name);

    return NextResponse.json({
      code,
      expires_at: expiresAt.toISOString(),
      lock_status: lockStatus,
    });
  });
}
