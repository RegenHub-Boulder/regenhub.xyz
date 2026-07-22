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

import { defaultEmailFrom as defaultFrom, defaultEmailReplyTo as defaultReplyTo } from "@regenhub/shared";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text fallback. Auto-derived from html if not provided. */
  text?: string;
  /** Override the From address. */
  from?: string;
  /** Override reply-to. Defaults to defaultReplyTo() — Aaron's personal inbox
   *  for member coordination so replies don't sit unread in a shared address. */
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

export interface SendResult {
  ok: boolean;
  /** Transient per-second rate limit (429 "too many requests") — back off + retry. */
  rateLimited: boolean;
  /** Daily sending quota reached — won't clear for hours. STOP and resume later;
   *  do NOT burn the recipient's retry budget. */
  quotaExceeded: boolean;
  /** Resend message id on success. */
  id?: string;
  error?: string;
}

/** Classify a Resend error string. Quota is checked first (a daily-quota error can
 *  also carry a 429, but it must NOT be treated as a transient rate limit). */
function classifyError(blob: string): { rateLimited: boolean; quotaExceeded: boolean } {
  const quotaExceeded = /quota|sending limit|daily limit/i.test(blob);
  const rateLimited = !quotaExceeded && /rate.?limit|too many|429/i.test(blob);
  return { rateLimited, quotaExceeded };
}

/**
 * Like sendEmail, but returns a structured result so a bulk sender can tell a
 * rate-limit (retry) apart from a hard failure (give up) and record the Resend
 * message id. Used by the newsletter send engine.
 */
export async function sendEmailDetailed(input: SendEmailInput): Promise<SendResult> {
  const resend = getResend();
  if (!resend) return { ok: false, rateLimited: false, quotaExceeded: false, error: "email not configured" };
  try {
    const { data, error } = await resend.emails.send({
      from: input.from ?? defaultFrom(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text ?? input.html.replace(/<[^>]+>/g, ""),
      replyTo: input.replyTo ?? defaultReplyTo(),
    });
    if (error) {
      const message = (error as { message?: string }).message ?? "send failed";
      const { rateLimited, quotaExceeded } = classifyError(`${(error as { name?: string }).name ?? ""} ${message}`);
      return { ok: false, rateLimited, quotaExceeded, error: message };
    }
    return { ok: true, rateLimited: false, quotaExceeded: false, id: data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { rateLimited, quotaExceeded } = classifyError(msg);
    return { ok: false, rateLimited, quotaExceeded, error: msg };
  }
}

// ============================================================
// Templates
// ============================================================

/**
 * Sent when an admin approves a free-day claim. Tells the applicant they
 * have a day pass waiting in their account, where to redeem it, and what
 * to expect when they arrive.
 */
export function freeDayApprovedEmail(args: { name: string; siteUrl: string }) {
  const firstName = args.name.split(" ")[0];
  const base = args.siteUrl.replace(/\/$/, "");
  return {
    subject: "Your RegenHub day pass is ready",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
        <p>Hi ${firstName},</p>
        <p>You&rsquo;re cleared to visit RegenHub — <strong>a day pass is waiting in your account.</strong></p>
        <p>When you&rsquo;re ready to come in any weekday between 8&nbsp;AM and 6&nbsp;PM:</p>
        <p style="margin: 20px 0;">
          <a href="${base}/portal/passes" style="background: #2d5e3e; color: white; padding: 12px 20px; border-radius: 8px; text-decoration: none; display: inline-block;">Get my door code</a>
        </p>
        <p>You&rsquo;ll sign in with your email (no password — we&rsquo;ll send you a one-time link), tap <strong>Generate code</strong>, and get a 6-digit PIN valid until 6&nbsp;PM that day. It works on both 2nd-floor door keypads — front and back.</p>
        <h3 style="margin-top: 28px;">When you arrive</h3>
        <p style="margin: 6px 0;"><strong>Address:</strong> 1515 Walnut St, Suite 200, Boulder, CO</p>
        <p style="margin: 6px 0;"><strong>Hours:</strong> Monday&ndash;Friday, 8&nbsp;AM&ndash;6&nbsp;PM</p>
        <p style="margin: 6px 0;">The street-level door is unlocked during open hours — head up to the 2nd floor. Type your code followed by the <strong>#</strong> key at the keypad, wait for the green LED and click, then pull the handle within 5 seconds. We&rsquo;ll be around — please say hi.</p>
        <p>Any questions, just reply to this email — replies go straight to us.</p>
        <p>See you soon,<br>RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nYou're cleared to visit RegenHub — a day pass is waiting in your account.\n\nWhen you're ready to come in any weekday between 8 AM and 6 PM, sign in at:\n${base}/portal/passes\n\nWe'll email you a one-time sign-in link (no password). Tap "Generate code" and you'll get a 6-digit PIN valid until 6 PM that day. It works on both 2nd-floor door keypads — front and back.\n\nWhen you arrive:\nAddress: 1515 Walnut St, Suite 200, Boulder, CO\nHours: Monday–Friday, 8 AM–6 PM\nThe street-level door is unlocked during open hours — head up to the 2nd floor. Type your code followed by # at the keypad, wait for the green LED and click, then pull the handle within 5 seconds. We'll be around — please say hi.\n\nAny questions, just reply to this email — replies go straight to us.\n\nSee you soon,\nRegenHub`,
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
        <p><strong>1. Your day pass — already in your account.</strong> Come any weekday between 8&nbsp;AM and 6&nbsp;PM. When you&rsquo;re ready, sign in and tap <strong>Generate code</strong>:</p>
        <p style="margin: 16px 0;">
          <a href="${base}/portal/passes" style="background: #2d5e3e; color: white; padding: 10px 18px; border-radius: 8px; text-decoration: none; display: inline-block;">Get my door code</a>
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
    text: `Hi ${firstName},\n\nWelcome — you're approved on two fronts:\n\n1. Your day pass is already in your account. Come any weekday between 8 AM and 6 PM. Sign in at ${base}/portal/passes and tap "Generate code" to get your 6-digit PIN.\n\n2. RegenHub membership. You're also cleared to sign up for any tier when you're ready:\n- Member + 1 day/mo — $30/mo, 1 coworking day per month, member rate on extras\n- Member + 2 days/mo — $50/mo\n- Member + 5 days/mo — $100/mo\n- Hot Desk — $250/mo, permanent door code + 24/7 access to any open desk\n- Cold Desk — $500/mo, your own reserved desk + permanent door code + 24/7 access\n\nDay passes accumulate — they never expire. Plus members get day passes at $25 instead of $30, and access to members-only events. Full Access tiers (Hot/Cold Desk) auto-allocate your PIN on signup.\n\nSee tiers: ${base}/membership\n\nAddress: 1515 Walnut St, Suite 200, Boulder, CO\n\nAny questions, just reply.\n\nSee you soon,\nRegenHub`,
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

/**
 * Sent automatically when an admin approves an application with a specific
 * plan + rate — carries the Stripe Checkout link so the applicant can
 * complete signup without anyone having to paste the URL into a DM.
 */
export function approvalCheckoutEmail(args: {
  name: string;
  planLabel: string;
  monthlyCents: number;
  discountCents?: number | null;
  discountDuration?: "forever" | "repeating" | null;
  discountMonths?: number | null;
  checkoutUrl: string;
  siteUrl: string;
}) {
  const firstName = args.name.split(" ")[0];
  const base = args.siteUrl.replace(/\/$/, "");
  const rate = `$${(args.monthlyCents / 100).toFixed(0)}/mo`;

  let discountLine = "";
  if (args.discountCents && args.discountCents > 0) {
    const off = `$${(args.discountCents / 100).toFixed(0)} off`;
    discountLine =
      args.discountDuration === "repeating" && args.discountMonths
        ? `${off} for your first ${args.discountMonths} month${args.discountMonths === 1 ? "" : "s"}`
        : `${off} every month`;
  }

  return {
    subject: `You're approved — complete your RegenHub membership (${args.planLabel})`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
        <p>Hi ${firstName},</p>
        <p>Great news — your RegenHub application is approved. We&rsquo;ve set you up as:</p>
        <p style="margin: 12px 0; font-size: 17px;"><strong>${args.planLabel}</strong> &mdash; ${rate}${discountLine ? ` <span style="color: #b45309;">(${discountLine})</span>` : ""}</p>
        <p>Complete your signup here — it takes about a minute:</p>
        <p style="margin: 20px 0;">
          <a href="${args.checkoutUrl}" style="background: #2d5e3e; color: white; padding: 12px 20px; border-radius: 8px; text-decoration: none; display: inline-block;">Complete my membership</a>
        </p>
        <p>Once that&rsquo;s done, everything lands in your member portal at <a href="${base}/portal" style="color: #2d5e3e;">${base.replace(/^https?:\/\//, "")}/portal</a> — day passes, door codes, and billing.</p>
        <p>Any questions — or if you&rsquo;d like a different plan — just reply to this email.</p>
        <p>Welcome aboard,<br>RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nGreat news — your RegenHub application is approved. We've set you up as:\n\n${args.planLabel} — ${rate}${discountLine ? ` (${discountLine})` : ""}\n\nComplete your signup here (takes about a minute):\n${args.checkoutUrl}\n\nOnce that's done, everything lands in your member portal at ${base}/portal — day passes, door codes, and billing.\n\nAny questions — or if you'd like a different plan — just reply to this email.\n\nWelcome aboard,\nRegenHub`,
  };
}

// ============================================================
// Lifecycle nudges (Bet 1) — warm, short, one idea per email
// ============================================================

/** Member was approved + has a pass but never came in. */
export function nudgeNeverVisitedEmail(args: { name: string; balance: number; siteUrl: string }) {
  const firstName = args.name.split(" ")[0];
  const base = args.siteUrl.replace(/\/$/, "");
  const passes = args.balance === 1 ? "a day pass" : `${args.balance} day passes`;
  return {
    subject: `${firstName}, your RegenHub day pass is still waiting`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
        <p>Hi ${firstName},</p>
        <p>Just a friendly nudge — you still have ${passes} sitting in your RegenHub account, ready whenever you are.</p>
        <p>We're open Monday&ndash;Friday, 8&nbsp;AM&ndash;6&nbsp;PM at 1515 Walnut St, Suite 200, Boulder. When you're ready to come in:</p>
        <p style="margin: 20px 0;">
          <a href="${base}/portal/passes" style="background: #2d5e3e; color: white; padding: 12px 20px; border-radius: 8px; text-decoration: none; display: inline-block;">Get my door code</a>
        </p>
        <p>No pressure, no expiration — your pass keeps. We'd just love to meet you.</p>
        <p>Any questions, just reply.</p>
        <p>See you soon,<br>RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nJust a friendly nudge — you still have ${passes} sitting in your RegenHub account, ready whenever you are.\n\nWe're open Monday–Friday, 8 AM–6 PM at 1515 Walnut St, Suite 200, Boulder. When you're ready to come in, grab your door code:\n${base}/portal/passes\n\nNo pressure, no expiration — your pass keeps. We'd just love to meet you.\n\nAny questions, just reply.\n\nSee you soon,\nRegenHub`,
  };
}

/** Member visited at least once, hasn't been back in a bit. */
export function nudgeComeBackEmail(args: { name: string; balance: number; siteUrl: string }) {
  const firstName = args.name.split(" ")[0];
  const base = args.siteUrl.replace(/\/$/, "");
  const passLine = args.balance > 0
    ? `You still have ${args.balance === 1 ? "a day pass" : `${args.balance} day passes`} in your account — `
    : "";
  return {
    subject: `${firstName}, come co-work with us again?`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
        <p>Hi ${firstName},</p>
        <p>It was lovely having you at the hub — we'd love to see you again. ${passLine}the door's open Monday&ndash;Friday, 8&nbsp;AM&ndash;6&nbsp;PM.</p>
        <p style="margin: 20px 0;">
          <a href="${base}/portal/passes" style="background: #2d5e3e; color: white; padding: 12px 20px; border-radius: 8px; text-decoration: none; display: inline-block;">Plan my next visit</a>
        </p>
        <p>And if RegenHub is starting to feel like your kind of place, membership starts at $30/month with a coworking day included — <a href="${base}/membership" style="color: #2d5e3e;">have a look at the tiers</a> whenever you're curious.</p>
        <p>Any questions, just reply.</p>
        <p>Warmly,<br>RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nIt was lovely having you at the hub — we'd love to see you again. ${passLine}the door's open Monday–Friday, 8 AM–6 PM.\n\nPlan your next visit: ${base}/portal/passes\n\nAnd if RegenHub is starting to feel like your kind of place, membership starts at $30/month with a coworking day included — see the tiers at ${base}/membership whenever you're curious.\n\nAny questions, just reply.\n\nWarmly,\nRegenHub`,
  };
}

/** Member used their last pass. The moment of maximum motivation. */
export function nudgeBalanceEmptyEmail(args: { name: string; siteUrl: string }) {
  const firstName = args.name.split(" ")[0];
  const base = args.siteUrl.replace(/\/$/, "");
  return {
    subject: `${firstName}, the easy way back into the hub`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
        <p>Hi ${firstName},</p>
        <p>You've used up your day passes — thanks for spending those days with us. If RegenHub is working for you, here are the two easy ways back in:</p>
        <ul style="line-height: 1.8; padding-left: 20px;">
          <li><strong>Become a member from $30/month</strong> — includes a coworking day every month (they accumulate and never expire), member pricing on extras, and members-only events. <a href="${base}/membership" style="color: #2d5e3e;">See the tiers</a></li>
          <li><strong>Grab a single day pass</strong> for $30 whenever you need one. <a href="${base}/portal/passes" style="color: #2d5e3e;">Buy a pass</a></li>
        </ul>
        <p>The membership math works out better after one visit a month — and it supports the cooperative.</p>
        <p>Any questions, just reply — happy to help you pick.</p>
        <p>Warmly,<br>RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nYou've used up your day passes — thanks for spending those days with us. If RegenHub is working for you, here are the two easy ways back in:\n\n1. Become a member from $30/month — includes a coworking day every month (they accumulate and never expire), member pricing on extras, and members-only events. See tiers: ${base}/membership\n\n2. Grab a single day pass for $30 whenever you need one: ${base}/portal/passes\n\nThe membership math works out better after one visit a month — and it supports the cooperative.\n\nAny questions, just reply — happy to help you pick.\n\nWarmly,\nRegenHub`,
  };
}

// ============================================================
// Hub health digest (Bet 2) — radical transparency lite
// ============================================================

export interface HubDigestStats {
  monthLabel: string;           // "May 2026"
  mrrCents: number;
  payingMembers: number;
  tierCounts: { label: string; count: number }[];
  newMembers: number;
  totalVisits: number;
  distinctVisitors: number;
  dayCodesIssued: number;
  freeDaySignups: number;
}

export function hubHealthDigestEmail(args: {
  stats: HubDigestStats;
  note: string | null;
  noteAuthor: string | null;
  siteUrl: string;
}) {
  const { stats } = args;
  const base = args.siteUrl.replace(/\/$/, "");
  const mrr = `$${(stats.mrrCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const tierRows = stats.tierCounts
    .map((t) => `<tr><td style="padding: 4px 12px 4px 0; color: #555;">${t.label}</td><td style="padding: 4px 0; font-weight: 600;">${t.count}</td></tr>`)
    .join("");
  const tierText = stats.tierCounts.map((t) => `  ${t.label}: ${t.count}`).join("\n");
  const noteHtml = args.note
    ? `<div style="background: #f0f4f1; border-left: 3px solid #2d5e3e; padding: 14px 18px; margin: 22px 0; border-radius: 0 8px 8px 0;">
        <p style="margin: 0; white-space: pre-wrap;">${args.note}</p>
        ${args.noteAuthor ? `<p style="margin: 8px 0 0; font-size: 13px; color: #555;">— ${args.noteAuthor}</p>` : ""}
      </div>`
    : "";
  const noteText = args.note ? `\n${args.note}${args.noteAuthor ? `\n— ${args.noteAuthor}` : ""}\n` : "";

  return {
    subject: `RegenHub pulse — ${stats.monthLabel}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
        <p style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #2d5e3e; margin-bottom: 4px;">Hub pulse · ${stats.monthLabel}</p>
        <h2 style="margin: 0 0 16px;">How the cooperative is doing</h2>
        <p>As a cooperative, we believe everyone who's part of RegenHub should see how it's going — the numbers below are the same ones we look at.</p>
        ${noteHtml}
        <table style="width: 100%; border-collapse: collapse; margin: 18px 0;">
          <tr><td style="padding: 4px 12px 4px 0; color: #555;">Monthly recurring revenue</td><td style="padding: 4px 0; font-weight: 600;">${mrr}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #555;">Paying members</td><td style="padding: 4px 0; font-weight: 600;">${stats.payingMembers}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #555;">New members this month</td><td style="padding: 4px 0; font-weight: 600;">${stats.newMembers}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #555;">Door entries</td><td style="padding: 4px 0; font-weight: 600;">${stats.totalVisits}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #555;">Distinct visitors</td><td style="padding: 4px 0; font-weight: 600;">${stats.distinctVisitors}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #555;">Day codes issued</td><td style="padding: 4px 0; font-weight: 600;">${stats.dayCodesIssued}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #555;">Free-day signups</td><td style="padding: 4px 0; font-weight: 600;">${stats.freeDaySignups}</td></tr>
        </table>
        <p style="font-size: 14px; color: #555; margin-bottom: 4px;">Members by tier:</p>
        <table style="border-collapse: collapse; margin: 4px 0 18px;">${tierRows}</table>
        <p>Questions, ideas, or want to get more involved in the cooperative? Just reply — it goes straight to a human.</p>
        <p>With gratitude,<br>RegenHub</p>
      </div>
    `,
    text: `HUB PULSE — ${stats.monthLabel}\n\nAs a cooperative, we believe everyone who's part of RegenHub should see how it's going — these are the same numbers we look at.\n${noteText}\nMonthly recurring revenue: ${mrr}\nPaying members: ${stats.payingMembers}\nNew members this month: ${stats.newMembers}\nDoor entries: ${stats.totalVisits}\nDistinct visitors: ${stats.distinctVisitors}\nDay codes issued: ${stats.dayCodesIssued}\nFree-day signups: ${stats.freeDaySignups}\n\nMembers by tier:\n${tierText}\n\nQuestions, ideas, or want to get more involved in the cooperative? Just reply — it goes straight to a human.\n\nWith gratitude,\nRegenHub\n\n${base}`,
  };
}
