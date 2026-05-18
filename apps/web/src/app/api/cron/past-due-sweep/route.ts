import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";

const GRACE_DAYS = 7;

async function notifyTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error("[PastDueCron] Telegram error:", err);
  }
}

/**
 * POST /api/cron/past-due-sweep
 *
 * Flips members back to day_pass after the 7-day grace period on a
 * failed payment expires. Designed to be hit daily by Coolify cron.
 *
 * Auth: requires `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not set on this environment" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createServiceClient();
  const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Find subscriptions in their grace window that are past the cutoff and
  // haven't already been disabled.
  const { data: stale, error } = await admin
    .from("subscriptions")
    .select("id, member_id, stripe_subscription_id, past_due_since, members(name)")
    .lt("past_due_since", cutoff)
    .is("access_disabled_at", null)
    .not("past_due_since", "is", null);

  if (error) {
    console.error("[PastDueCron] Query error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  const now = new Date().toISOString();
  let flipped = 0;
  for (const row of stale ?? []) {
    await admin
      .from("subscriptions")
      .update({ access_disabled_at: now })
      .eq("id", row.id);
    await admin
      .from("members")
      .update({ member_type: "day_pass" })
      .eq("id", row.member_id);
    // @ts-expect-error nested join shape
    const name = row.members?.name ?? "A member";
    await notifyTelegram(
      `🔒 *Access downgraded*\n\n${name}'s payment failed >7 days ago. Moved to day-pass status.`,
    );
    flipped++;
  }

  return NextResponse.json({ swept: (stale ?? []).length, flipped });
}
