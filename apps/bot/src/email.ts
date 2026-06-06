import { Resend } from "resend";

// Bot-side email helper. Mirrors apps/web/src/lib/email.ts (kept duplicated
// rather than extracted to packages/shared because the bot is a tiny node
// runtime and pulling in the full shared package + its build chain isn't
// worth the abstraction for two short functions).

let resendClient: Resend | null = null;

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

function defaultFrom(): string {
  return process.env.EMAIL_FROM ?? "RegenHub <noreply@mail.unforced.dev>";
}

function defaultReplyTo(): string {
  return process.env.EMAIL_REPLY_TO ?? "ag@unforced.org";
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const resend = getResend();
  if (!resend) {
    console.warn("[email] RESEND_API_KEY not set — skipping send");
    return false;
  }
  try {
    const { error } = await resend.emails.send({
      from: defaultFrom(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text ?? input.html.replace(/<[^>]+>/g, ""),
      replyTo: input.replyTo ?? defaultReplyTo(),
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
        <p><strong>2. RegenHub membership.</strong> You&rsquo;re also cleared to sign up for any tier when you&rsquo;re ready:</p>
        <ul style="line-height: 1.7; padding-left: 20px;">
          <li><strong>Member + 1 day/mo</strong> &mdash; $30/mo, 1 coworking day per month, member rate on extras</li>
          <li><strong>Member + 2 days/mo</strong> &mdash; $50/mo</li>
          <li><strong>Member + 5 days/mo</strong> &mdash; $100/mo</li>
          <li><strong>Hot Desk</strong> &mdash; $250/mo, permanent door code + 24/7 access to any open desk</li>
          <li><strong>Cold Desk</strong> &mdash; $500/mo, your own reserved desk + permanent door code + 24/7 access</li>
        </ul>
        <p>Day passes accumulate &mdash; they never expire. Plus members get day passes at $25 instead of $30, and access to members-only events. Full Access tiers (Hot/Cold Desk) auto-allocate your PIN on signup.</p>
        <p style="margin: 16px 0;">
          <a href="${base}/membership" style="background: #2d5e3e; color: white; padding: 10px 18px; border-radius: 8px; text-decoration: none; display: inline-block;">See membership tiers</a>
        </p>
        <p><strong>Address:</strong> 1515 Walnut St, Suite 200, Boulder, CO</p>
        <p>Any questions, just reply.</p>
        <p>See you soon,<br>RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nWelcome — you're approved on two fronts:\n\n1. Your free day visit. Come any weekday between 8 AM and 6 PM. On the day you arrive, grab your door code here:\n${base}/freeday\n\n2. RegenHub membership. You're also cleared to sign up for any tier when you're ready:\n- Member + 1 day/mo — $30/mo, 1 coworking day per month, member rate on extras\n- Member + 2 days/mo — $50/mo\n- Member + 5 days/mo — $100/mo\n- Hot Desk — $250/mo, permanent door code + 24/7 access to any open desk\n- Cold Desk — $500/mo, your own reserved desk + permanent door code + 24/7 access\n\nDay passes accumulate — they never expire. Plus members get day passes at $25 instead of $30, and access to members-only events. Full Access tiers (Hot/Cold Desk) auto-allocate your PIN on signup.\n\nSee tiers: ${base}/membership\n\nAddress: 1515 Walnut St, Suite 200, Boulder, CO\n\nAny questions, just reply.\n\nSee you soon,\nRegenHub`,
  };
}
