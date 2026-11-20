import { createServiceClient } from "@/lib/supabase/admin";
import { verifyUnsubscribeToken } from "@/lib/newsletter";
import { emailLinkPage } from "@/lib/emailLinkPage";

/**
 * GET /api/newsletter/unsubscribe?email=…&token=…
 *
 * One-click unsubscribe from the newsletter. Token is an HMAC of the email
 * so links can't be forged to unsubscribe other people. Idempotent.
 *
 * Stops the newsletter and the notes after nights (night follow-ups, migration
 * 066: decide_night_followups holds anyone in email_unsubscribes). Transactional
 * email (door codes, approvals, billing) is unaffected.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const email = searchParams.get("email")?.trim().toLowerCase();
  const token = searchParams.get("token");

  const page = emailLinkPage;

  if (!email || !token) {
    return page("Invalid link", "This unsubscribe link is missing some pieces. If you're trying to stop the newsletter, reply to any issue and we'll take care of it by hand.", false);
  }
  if (!verifyUnsubscribeToken(email, token)) {
    return page("Invalid link", "This unsubscribe link doesn't check out. If you're trying to stop the newsletter, reply to any issue and we'll take care of it by hand.", false);
  }

  const admin = createServiceClient();
  const { error } = await admin
    .from("email_unsubscribes")
    .upsert({ email, source: "link" }, { onConflict: "email" });

  if (error) {
    console.error("[Unsubscribe] upsert error:", error);
    return page("Something went wrong", "We couldn't process the unsubscribe. Reply to any newsletter and we'll sort it manually.", false);
  }

  return page(
    "You're unsubscribed",
    "You won't get the RegenHub newsletter or our notes after nights anymore. Anything transactional (door codes, receipts) still works normally. Change your mind any time — just reply to an old issue.",
    true,
  );
}
