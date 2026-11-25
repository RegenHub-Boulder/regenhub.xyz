import { Resend } from "resend";

// Bot-side send. The templates are the web app's own, from @regenhub/shared (packages/shared/src/freeDayEmails.ts),
// so the two can't drift.

let resendClient: Resend | null = null;

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

import { defaultEmailFrom as defaultFrom, defaultEmailReplyTo as defaultReplyTo } from "@regenhub/shared";

export interface SendEmailInput {
  /** For the email log (migration 069): same kinds as the web app's lib/emailLog.ts EMAIL_KINDS. */
  kind: "free_day_approved" | "membership_approved";
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

/**
 * One row in email_log per send, as the web app's sendEmailDetailed writes (metadata only, never the body). Never
 * throws; before migration 069 runs the table is missing and this does nothing.
 */
async function logEmail(input: SendEmailInput, result: { id: string | null; error: string | null }) {
  try {
    const { db } = await import("./db/supabase.js");
    const insert = db.from("email_log").insert({
      email: input.to.trim().toLowerCase(),
      kind: input.kind,
      subject: input.subject.slice(0, 300),
      provider: "resend",
      provider_id: result.id,
      status: result.error ? "failed" : "sent",
      error: result.error ? result.error.replace(/\s+/g, " ").slice(0, 200) : null,
    });
    // Bounded: the mail has gone; a slow database must not hold up the bot.
    const timedOut = new Promise<{ error: { code?: string; message: string } }>((resolve) =>
      setTimeout(() => resolve({ error: { message: "timed out" } }), 2000).unref());
    const { error } = await Promise.race([Promise.resolve(insert), timedOut]) as { error: { code?: string; message: string } | null };
    if (error && error.code !== "42P01" && error.code !== "PGRST205") console.error("[email log] write failed:", error.message);
  } catch (err) {
    console.error("[email log] write failed:", err instanceof Error ? err.message : err);
  }
}

export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const resend = getResend();
  if (!resend) {
    console.warn("[email] RESEND_API_KEY not set — skipping send");
    return false;
  }
  try {
    const { data, error } = await resend.emails.send({
      from: defaultFrom(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text ?? input.html.replace(/<[^>]+>/g, ""),
      replyTo: input.replyTo ?? defaultReplyTo(),
    });
    if (error) {
      console.error("[email] Resend send error:", error);
      await logEmail(input, { id: null, error: error.message ?? "send failed" });
      return false;
    }
    await logEmail(input, { id: data?.id ?? null, error: null });
    return true;
  } catch (err) {
    console.error("[email] Unexpected send error:", err);
    await logEmail(input, { id: null, error: err instanceof Error ? err.message : "send failed" });
    return false;
  }
}
