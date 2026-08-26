import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  BILLING_GRACE_DAYS,
  downgradeMembershipAccess,
} from "@/lib/membershipLifecycle";

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
  const cutoff = new Date(
    Date.now() - BILLING_GRACE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  type StaleRow = {
    id: number;
    member_id: number;
    stripe_subscription_id: string;
    plan_key: string;
    past_due_since: string | null;
    members: { name: string; pin_code_slot: number | null; member_type: string } | null;
  };

  // Find subscriptions in their grace window that are past the cutoff and
  // haven't already been disabled. Pulls the member's PIN slot + type so we
  // can revoke door access in the same pass.
  const { data: stale, error } = await admin
    .from("subscriptions")
    .select("id, member_id, stripe_subscription_id, plan_key, past_due_since, members(name, pin_code_slot, member_type)")
    .lt("past_due_since", cutoff)
    .is("access_disabled_at", null)
    .not("past_due_since", "is", null)
    .returns<StaleRow[]>();

  if (error) {
    console.error("[PastDueCron] Query error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  const now = new Date().toISOString();
  const results: { subscription_id: number; member_id: number; ok: boolean; error?: string }[] = [];

  for (const row of stale ?? []) {
    try {
      const { error: subErr } = await admin
        .from("subscriptions")
        .update({ access_disabled_at: now })
        .eq("id", row.id);
      if (subErr) throw subErr;

      // If they were a Full member (cold/hot desk), revoke the door code:
      // clear the slot, null the pin, and push null to the Z-Wave lock.
      // Hub friends + social tiers don't have permanent PINs so this is a no-op.
      const wasFullMember =
        row.members?.member_type === "cold_desk" || row.members?.member_type === "hot_desk";
      const slot = row.members?.pin_code_slot ?? null;
      let lockRevokeNote = "";
      const downgrade = await downgradeMembershipAccess(admin, {
        memberId: row.member_id,
        currentPinSlot: slot,
        revokePermanentPin: wasFullMember,
      });
      if (downgrade.memberUpdateError) throw downgrade.memberUpdateError;
      if (downgrade.revokedSlot && downgrade.lockRevokeFailed) {
        lockRevokeNote = `\n\n⚠️ *Action needed:* Lock revoke failed for slot ${downgrade.revokedSlot}. Run Lock Sync from /admin/access.`;
      } else if (downgrade.revokedSlot && downgrade.lockStatus) {
        lockRevokeNote = `\n\n🔒 Cleared PIN slot ${downgrade.revokedSlot}: ${downgrade.lockStatus}`;
      }

      const name = row.members?.name ?? "A member";
      await notifyTelegram(
        `🔒 *Access downgraded*\n\n${name}'s payment failed >7 days ago. Moved to day-pass status.${lockRevokeNote}`,
      );
      results.push({ subscription_id: row.id, member_id: row.member_id, ok: true });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[PastDueCron] Failed for subscription ${row.id}:`, errorMsg);
      results.push({ subscription_id: row.id, member_id: row.member_id, ok: false, error: errorMsg });
    }
  }

  const flipped = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  if (failed.length > 0) {
    await notifyTelegram(
      `⚠️ *Past-due sweep partial failure*\n\n${failed.length} of ${results.length} flips failed. Inspect: ${failed.map((f) => `sub#${f.subscription_id}`).join(", ")}`,
    );
  }

  return NextResponse.json({
    swept: results.length,
    flipped,
    failed: failed.length,
    failures: failed,
  });
}
