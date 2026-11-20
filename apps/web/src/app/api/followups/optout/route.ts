import { createServiceClient } from "@/lib/supabase/admin";
import { verifyFollowupOptoutToken } from "@/lib/newsletter";

/**
 * GET /api/followups/optout?email=…&token=…
 *
 * "No more notes after nights": the link in every night follow-up (lib/nightFollowups.ts). Sets the per-person flag
 * (night_followup_optouts, migration 066); decide_night_followups holds anyone flagged. The token is an HMAC of the
 * email, scoped apart from the newsletter's unsubscribe token. Idempotent. The newsletter is unaffected.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const email = searchParams.get("email")?.trim().toLowerCase();
  const token = searchParams.get("token");

  const page = (title: string, body: string, ok: boolean) =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
       <title>${title} — RegenHub</title></head>
       <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0e1410; color: #e8ece9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0;">
         <div style="max-width: 420px; padding: 40px; text-align: center;">
           <h1 style="color: ${ok ? "#7fb069" : "#e07a5f"}; font-size: 22px;">${title}</h1>
           <p style="color: #a8b0aa; line-height: 1.6;">${body}</p>
           <p style="margin-top: 28px;"><a href="https://regenhub.xyz" style="color: #7fb069;">regenhub.xyz</a></p>
         </div>
       </body></html>`,
      { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );

  if (!email || !token || !verifyFollowupOptoutToken(email, token)) {
    return page("Invalid link", "This link doesn't check out. Reply to the note instead and we'll take you off by hand.", false);
  }
  const { error } = await createServiceClient()
    .from("night_followup_optouts")
    .upsert({ email, source: "link" }, { onConflict: "email" });
  if (error) {
    console.error("[followup optout] upsert error:", error);
    return page("Something went wrong", "We couldn't save that. Reply to the note and we'll take you off by hand.", false);
  }
  return page(
    "No more notes after nights",
    "You won't get a note from us after the nights you RSVP to. The newsletter is separate; its own link stops it.",
    true,
  );
}
