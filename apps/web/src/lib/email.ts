import { Resend } from "resend";

let resendClient: Resend | null = null;

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;
}

function defaultFrom(): string {
  return process.env.EMAIL_FROM ?? "RegenHub <noreply@mail.unforced.dev>";
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text fallback. Auto-derived from html if not provided. */
  text?: string;
  /** Override the From address. */
  from?: string;
  /** Reply-to (e.g. so reply goes to boulder.regenhub@gmail.com) */
  replyTo?: string;
}

/**
 * Send a transactional email via Resend.
 *
 * Returns true on success. Logs + returns false on failure — callers should
 * treat email as best-effort, not load-bearing for app correctness. If email
 * isn't configured, returns false silently.
 */
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const resend = getResend();
  if (!resend) {
    console.warn("[email] RESEND_API_KEY not set — skipping send");
    return false;
  }
  try {
    const { error } = await resend.emails.send({
      from: input.from ?? defaultFrom(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text ?? input.html.replace(/<[^>]+>/g, ""),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    });
    if (error) {
      console.error("[email] Resend send error:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] Unexpected send error:", err);
    return false;
  }
}

// ============================================================
// Templates
// ============================================================

/**
 * Sent when an admin approves a free-day claim. Tells the applicant they
 * can come in any weekday during business hours; gives them the link to
 * grab their door code on the day they arrive.
 */
export function freeDayApprovedEmail(args: { name: string; siteUrl: string }) {
  const firstName = args.name.split(" ")[0];
  const link = `${args.siteUrl.replace(/\/$/, "")}/freeday`;
  return {
    subject: "Your RegenHub free day is approved",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
        <p>Hi ${firstName},</p>
        <p>You&rsquo;re approved for a free day at RegenHub. Come visit any weekday between 8&nbsp;AM and 6&nbsp;PM.</p>
        <p>On the day you arrive, click the link below to grab your door code:</p>
        <p style="margin: 24px 0;">
          <a href="${link}" style="background: #2d5e3e; color: white; padding: 12px 20px; border-radius: 8px; text-decoration: none; display: inline-block;">Get my door code</a>
        </p>
        <p>You'll get a 6-digit code valid until 6&nbsp;PM that day. The code works for the front door keypad.</p>
        <p><strong>Address:</strong><br>1515 Walnut St, Suite 200<br>Boulder, CO</p>
        <p>Any questions? Just reply to this email.</p>
        <p>See you soon,<br>RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nYou're approved for a free day at RegenHub. Come visit any weekday between 8 AM and 6 PM.\n\nOn the day you arrive, grab your door code here:\n${link}\n\nYou'll get a 6-digit code valid until 6 PM that day. The code works for the front door keypad.\n\nAddress: 1515 Walnut St, Suite 200, Boulder, CO\n\nAny questions? Just reply to this email.\n\nSee you soon,\nRegenHub`,
  };
}

/**
 * Sent when admin approves a free-day claim AND clears the applicant to
 * subscribe to a contributing membership. Combines the freeday email above
 * with a separate /membership invitation.
 */
export function freeDayPlusMembershipApprovedEmail(args: { name: string; siteUrl: string }) {
  const firstName = args.name.split(" ")[0];
  const base = args.siteUrl.replace(/\/$/, "");
  return {
    subject: "You're approved for a free day + RegenHub membership",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
        <p>Hi ${firstName},</p>
        <p>Welcome — you&rsquo;re approved on two fronts:</p>
        <p><strong>1. Your free day visit.</strong> Come any weekday between 8&nbsp;AM and 6&nbsp;PM. On the day you arrive, grab your door code here:</p>
        <p style="margin: 16px 0;">
          <a href="${base}/freeday" style="background: #2d5e3e; color: white; padding: 10px 18px; border-radius: 8px; text-decoration: none; display: inline-block;">Get my free-day code</a>
        </p>
        <p><strong>2. RegenHub membership.</strong> You&rsquo;re also cleared to sign up for a contributing membership when you&rsquo;re ready:</p>
        <ul style="line-height: 1.7; padding-left: 20px;">
          <li><strong>Interim Member</strong> &mdash; $30/mo, 1 coworking day per month, member rate on extras</li>
          <li><strong>Member + 2 days/mo</strong> &mdash; $50/mo</li>
          <li><strong>Member + 5 days/mo</strong> &mdash; $100/mo</li>
        </ul>
        <p>Day passes accumulate &mdash; they never expire. Plus members get day passes at $25 instead of $30, and access to members-only events.</p>
        <p style="margin: 16px 0;">
          <a href="${base}/membership" style="background: #2d5e3e; color: white; padding: 10px 18px; border-radius: 8px; text-decoration: none; display: inline-block;">See membership tiers</a>
        </p>
        <p>Looking for a permanent desk ($250 Hot Desk / $500 Cold Desk)? Reply to this email and we&rsquo;ll set up a quick chat &mdash; those go through a conversation rather than instant checkout.</p>
        <p><strong>Address:</strong> 1515 Walnut St, Suite 200, Boulder, CO</p>
        <p>Any questions, just reply.</p>
        <p>See you soon,<br>RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nWelcome — you're approved on two fronts:\n\n1. Your free day visit. Come any weekday between 8 AM and 6 PM. On the day you arrive, grab your door code here:\n${base}/freeday\n\n2. RegenHub membership. You're also cleared to sign up for a contributing membership when you're ready:\n- Interim Member — $30/mo, 1 coworking day per month, member rate on extras\n- Member + 2 days/mo — $50/mo\n- Member + 5 days/mo — $100/mo\n\nDay passes accumulate — they never expire. Plus members get day passes at $25 instead of $30, and access to members-only events.\n\nSee tiers: ${base}/membership\n\nLooking for a permanent desk ($250 Hot Desk / $500 Cold Desk)? Reply to this email and we'll set up a quick chat — those go through a conversation rather than instant checkout.\n\nAddress: 1515 Walnut St, Suite 200, Boulder, CO\n\nAny questions, just reply.\n\nSee you soon,\nRegenHub`,
  };
}

/**
 * Sent when admin approves an existing member to subscribe (via the
 * member-detail admin toggle, not the freeday flow). Skips the freeday
 * pitch since they're already on the inside.
 */
export function membershipApprovedEmail(args: { name: string; siteUrl: string }) {
  const firstName = args.name.split(" ")[0];
  const base = args.siteUrl.replace(/\/$/, "");
  return {
    subject: "You're cleared to subscribe to RegenHub membership",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
        <p>Hi ${firstName},</p>
        <p>You&rsquo;re approved to subscribe to a contributing membership at RegenHub whenever you&rsquo;re ready. Three tiers:</p>
        <ul style="line-height: 1.7; padding-left: 20px;">
          <li><strong>Interim Member</strong> &mdash; $30/mo, 1 coworking day per month, member rate on extras</li>
          <li><strong>Member + 2 days/mo</strong> &mdash; $50/mo</li>
          <li><strong>Member + 5 days/mo</strong> &mdash; $100/mo</li>
        </ul>
        <p>Day passes accumulate &mdash; they never expire. Plus members get day passes at $25 instead of $30, and access to members-only events.</p>
        <p style="margin: 16px 0;">
          <a href="${base}/membership" style="background: #2d5e3e; color: white; padding: 10px 18px; border-radius: 8px; text-decoration: none; display: inline-block;">See membership tiers</a>
        </p>
        <p>Any questions, just reply.</p>
        <p>&mdash; RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nYou're approved to subscribe to a contributing membership at RegenHub whenever you're ready. Three tiers:\n\n- Interim Member — $30/mo, 1 coworking day per month, member rate on extras\n- Member + 2 days/mo — $50/mo\n- Member + 5 days/mo — $100/mo\n\nDay passes accumulate — they never expire. Plus members get day passes at $25 instead of $30, and access to members-only events.\n\nSee tiers: ${base}/membership\n\nAny questions, just reply.\n\n— RegenHub`,
  };
}
