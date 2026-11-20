import { createServiceClient } from "@/lib/supabase/admin";
import { verifyFollowupOptoutToken } from "@/lib/newsletter";
import { emailLinkPage as page } from "@/lib/emailLinkPage";

/**
 * /api/followups/optout?email=…&token=… — "No more notes after nights", the link in every night follow-up
 * (lib/nightFollowups.ts). GET only shows a button (a mail scanner that opens every link changes nothing); its POST
 * sets the per-person flag (night_followup_optouts, migration 066), which holds them from every later batch. The
 * token is an HMAC of the email, scoped apart from the newsletter's unsubscribe token. Idempotent. The newsletter is
 * unaffected.
 */
function checked(req: Request): string | null {
  const { searchParams } = new URL(req.url);
  const email = searchParams.get("email")?.trim().toLowerCase();
  const token = searchParams.get("token");
  return email && token && verifyFollowupOptoutToken(email, token) ? email : null;
}

const invalid = () => page("Invalid link", "This link doesn't check out. Reply to the note instead and we'll take you off by hand.", false);

export async function GET(req: Request) {
  if (!checked(req)) return invalid();
  const url = new URL(req.url);
  return page(
    "No more notes after nights?",
    "We send a short note the day after a night you RSVP'd to. Stop them here. The newsletter is separate.",
    true,
    { label: "Stop the notes", action: `${url.pathname}${url.search}` },
  );
}

export async function POST(req: Request) {
  const email = checked(req);
  if (!email) return invalid();
  const { error } = await createServiceClient()
    .from("night_followup_optouts")
    .upsert({ email, source: "link" }, { onConflict: "email" });
  if (error) {
    console.error("[followup optout] upsert error:", error);
    return page("Something went wrong", "We couldn't save that. Reply to the note and we'll take you off by hand.", false);
  }
  return page("No more notes after nights", "You won't get a note from us after the nights you RSVP to. The newsletter is separate; its own link stops it.", true);
}
