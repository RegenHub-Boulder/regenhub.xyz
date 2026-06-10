import { createServiceClient } from "@/lib/supabase/admin";
import { unsubscribeToken } from "@/lib/newsletter";

/**
 * GET /api/newsletter/unsubscribe?email=…&token=…
 *
 * One-click unsubscribe from the newsletter. Token is an HMAC of the email
 * so links can't be forged to unsubscribe other people. Idempotent.
 *
 * Affects newsletter sends only — transactional email (door codes,
 * approvals, billing) is unaffected.
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

  if (!email || !token) {
    return page("Invalid link", "This unsubscribe link is missing some pieces. If you're trying to stop the newsletter, reply to any issue and we'll take care of it by hand.", false);
  }
  if (token !== unsubscribeToken(email)) {
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
    "You won't get the RegenHub newsletter anymore. Anything transactional (door codes, receipts) still works normally. Change your mind any time — just reply to an old issue.",
    true,
  );
}
