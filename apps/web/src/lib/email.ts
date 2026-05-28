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

/**
 * Sent when admin pings a past-due member to update their payment method.
 * Links to /portal where they can open the Stripe Customer Portal.
 */
export function paymentReminderEmail(args: {
  name: string;
  planLabel: string;
  monthlyDollars: number;
  siteUrl: string;
  daysOverdue: number | null;
}) {
  const firstName = args.name.split(" ")[0];
  const link = `${args.siteUrl.replace(/\/$/, "")}/portal`;
  const overdueLine = args.daysOverdue
    ? `Your card has been failing for ${args.daysOverdue} day${args.daysOverdue === 1 ? "" : "s"}.`
    : `Your last payment didn't go through.`;
  return {
    subject: "Update your RegenHub payment method",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
        <p>Hi ${firstName},</p>
        <p>Quick note &mdash; your ${args.planLabel} subscription ($${args.monthlyDollars}/mo) needs attention. ${overdueLine} Stripe will keep retrying for a few days but it&rsquo;s easiest to just update your card.</p>
        <p style="margin: 24px 0;">
          <a href="${link}" style="background: #2d5e3e; color: white; padding: 12px 20px; border-radius: 8px; text-decoration: none; display: inline-block;">Update payment method</a>
        </p>
        <p>Click the link, sign in, then hit &ldquo;Manage subscription&rdquo; &mdash; that opens the Stripe portal where you can swap your card.</p>
        <p>Reply to this email if anything&rsquo;s off &mdash; we&rsquo;re happy to chat.</p>
        <p>&mdash; RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nQuick note — your ${args.planLabel} subscription ($${args.monthlyDollars}/mo) needs attention. ${overdueLine} Stripe will keep retrying for a few days but it's easiest to just update your card.\n\nUpdate payment method: ${link}\n\nClick the link, sign in, then hit "Manage subscription" — that opens the Stripe portal where you can swap your card.\n\nReply to this email if anything's off — we're happy to chat.\n\n— RegenHub`,
  };
}

export interface DigestData {
  pendingApplications: number;
  pendingFreeDays: number;
  pastDueSubs: number;
  newApplicationsYesterday: number;
  newSignupsYesterday: number;
  newMembersYesterday: number;
  yesterdayVisits: { name: string; code: string; at: string }[];
  lockSyncFailed: number | null;
  siteUrl: string;
}

/**
 * Daily admin digest — sent once a day by /api/cron/admin-digest.
 * Skips entirely if there's nothing to report (no pending work + no
 * recent activity), so admins don't get noise on quiet days.
 */
export function adminDigestEmail(d: DigestData): { subject: string; html: string; text: string } | null {
  const hasActionable =
    d.pendingApplications + d.pendingFreeDays + d.pastDueSubs + (d.lockSyncFailed ?? 0) > 0;
  const hasActivity =
    d.newApplicationsYesterday + d.newSignupsYesterday + d.newMembersYesterday + d.yesterdayVisits.length > 0;
  if (!hasActionable && !hasActivity) return null;

  const base = d.siteUrl.replace(/\/$/, "");
  const dateLabel = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Denver",
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const subject = hasActionable
    ? `RegenHub admin — ${d.pendingApplications + d.pendingFreeDays + d.pastDueSubs} needs your attention`
    : `RegenHub admin — ${dateLabel}`;

  const lines: string[] = [`<p>Morning — quick rundown for ${dateLabel}.</p>`];
  const textLines: string[] = [`Morning — quick rundown for ${dateLabel}.`, ""];

  if (hasActionable) {
    lines.push(`<h3 style="color:#cb904d;margin-top:24px;margin-bottom:8px;">Needs attention</h3><ul style="line-height:1.7;padding-left:20px;">`);
    textLines.push("NEEDS ATTENTION");
    if (d.pendingApplications) {
      lines.push(`<li><strong>${d.pendingApplications}</strong> membership application${d.pendingApplications === 1 ? "" : "s"} pending — <a href="${base}/admin/pipeline?tab=applications">review →</a></li>`);
      textLines.push(`- ${d.pendingApplications} membership applications pending: ${base}/admin/pipeline?tab=applications`);
    }
    if (d.pendingFreeDays) {
      lines.push(`<li><strong>${d.pendingFreeDays}</strong> free-day claim${d.pendingFreeDays === 1 ? "" : "s"} pending — <a href="${base}/admin/pipeline?tab=freedays">review →</a></li>`);
      textLines.push(`- ${d.pendingFreeDays} free-day claims pending: ${base}/admin/pipeline?tab=freedays`);
    }
    if (d.pastDueSubs) {
      lines.push(`<li><strong>${d.pastDueSubs}</strong> subscription${d.pastDueSubs === 1 ? "" : "s"} past due — <a href="${base}/admin/billing">review →</a></li>`);
      textLines.push(`- ${d.pastDueSubs} subscriptions past due: ${base}/admin/billing`);
    }
    if (d.lockSyncFailed) {
      lines.push(`<li><strong>${d.lockSyncFailed}</strong> lock-sync failure${d.lockSyncFailed === 1 ? "" : "s"} from the last run — <a href="${base}/admin/access?tab=sync">retry →</a></li>`);
      textLines.push(`- ${d.lockSyncFailed} lock-sync failures: ${base}/admin/access?tab=sync`);
    }
    lines.push("</ul>");
    textLines.push("");
  }

  if (hasActivity) {
    lines.push(`<h3 style="color:#2d5e3e;margin-top:24px;margin-bottom:8px;">Yesterday</h3><ul style="line-height:1.7;padding-left:20px;">`);
    textLines.push("YESTERDAY");
    if (d.newSignupsYesterday) {
      lines.push(`<li>${d.newSignupsYesterday} interest signup${d.newSignupsYesterday === 1 ? "" : "s"}</li>`);
      textLines.push(`- ${d.newSignupsYesterday} interest signups`);
    }
    if (d.newApplicationsYesterday) {
      lines.push(`<li>${d.newApplicationsYesterday} new application${d.newApplicationsYesterday === 1 ? "" : "s"}</li>`);
      textLines.push(`- ${d.newApplicationsYesterday} new applications`);
    }
    if (d.newMembersYesterday) {
      lines.push(`<li>${d.newMembersYesterday} new paying member${d.newMembersYesterday === 1 ? "" : "s"} 🎉</li>`);
      textLines.push(`- ${d.newMembersYesterday} new paying members`);
    }
    if (d.yesterdayVisits.length) {
      lines.push(`<li>${d.yesterdayVisits.length} door access${d.yesterdayVisits.length === 1 ? "" : "es"}: ${d.yesterdayVisits.map((v) => v.name).join(", ")}</li>`);
      textLines.push(`- ${d.yesterdayVisits.length} door accesses: ${d.yesterdayVisits.map((v) => v.name).join(", ")}`);
    }
    lines.push("</ul>");
  }

  lines.push(`<p style="margin-top:24px;"><a href="${base}/admin">Open the admin dashboard →</a></p>`);
  textLines.push("", `Open the admin dashboard: ${base}/admin`);

  return {
    subject,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.55;">${lines.join("")}</div>`,
    text: textLines.join("\n"),
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
        <p>You&rsquo;re approved to subscribe to a RegenHub membership whenever you&rsquo;re ready. Five tiers:</p>
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
        <p>Any questions, just reply.</p>
        <p>&mdash; RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nYou're approved to subscribe to a RegenHub membership whenever you're ready. Five tiers:\n\n- Member + 1 day/mo — $30/mo, 1 coworking day per month, member rate on extras\n- Member + 2 days/mo — $50/mo\n- Member + 5 days/mo — $100/mo\n- Hot Desk — $250/mo, permanent door code + 24/7 access to any open desk\n- Cold Desk — $500/mo, your own reserved desk + permanent door code + 24/7 access\n\nDay passes accumulate — they never expire. Plus members get day passes at $25 instead of $30, and access to members-only events. Full Access tiers (Hot/Cold Desk) auto-allocate your PIN on signup.\n\nSee tiers: ${base}/membership\n\nAny questions, just reply.\n\n— RegenHub`,
  };
}
