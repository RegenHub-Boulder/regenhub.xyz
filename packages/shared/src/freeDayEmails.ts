/**
 * The free-day emails, and the membership approval the bot also sends: one copy for both apps (T-482 round 4).
 * The web app (apps/web/src/lib/email.ts) re-exports these; the bot (apps/bot/src/email.ts) imports them. Prices come
 * from ./prices.ts, never typed here. Plain words, the site's palette inline, a web-safe serif stack.
 */
import { DAY_PASS_MEMBER_CENTS, FREE_DAY_LAPSE_DAYS, PLAN_MONTHLY_CENTS, dollars } from "./prices.js";

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

const ADDRESS = "1515 Walnut St, Suite 200, Boulder, CO";
const MEMBERSHIP_FROM = dollars(PLAN_MONTHLY_CENTS.member_basic);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The greeting's first name: `html` escaped for the HTML part, `text` as typed for the plain-text part. */
const firstNameOf = (name: string) => {
  const text = name.trim().split(/\s+/)[0] || "there";
  return { html: esc(text), text };
};
const siteBase = (siteUrl: string) => siteUrl.replace(/\/+$/, "");

const shell = (body: string) => `
      <div style="font-family: 'EB Garamond', Garamond, 'Iowan Old Style', Palatino, Georgia, serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #f4f0e6; color: #27231d; line-height: 1.55;">
${body}
      </div>
    `;
const button = (href: string, label: string) =>
  `<p style="margin: 20px 0;"><a href="${href}" style="background: #4b5a2c; color: white; padding: 12px 20px; border-radius: 2px; text-decoration: none; display: inline-block;">${label}</a></p>`;
const link = (href: string, label: string) => `<a href="${href}" style="color: #4b5a2c;">${label}</a>`;

/** How to get in, the same in every approval. */
const ARRIVAL_HTML = `<h3 style="margin-top: 28px;">When you arrive</h3>
        <p style="margin: 6px 0;"><strong>Address:</strong> ${ADDRESS}</p>
        <p style="margin: 6px 0;"><strong>Hours:</strong> Monday&ndash;Friday, 8&nbsp;AM&ndash;6&nbsp;PM</p>
        <p style="margin: 6px 0;">The street door is open during those hours; come up to the 2nd floor. Type your code and then <strong>#</strong> on the keypad, wait for the green light and the click, and pull the handle within 5 seconds. Say hi when you&rsquo;re in.</p>`;
const ARRIVAL_TEXT = `When you arrive:\nAddress: ${ADDRESS}\nHours: Monday–Friday, 8 AM–6 PM\nThe street door is open during those hours; come up to the 2nd floor. Type your code and then # on the keypad, wait for the green light and the click, and pull the handle within 5 seconds. Say hi when you're in.`;

function approvedBody(first: { html: string; text: string }, base: string) {
  return {
    html: `<p>Hi ${first.html},</p>
        <p>Your free day at RegenHub is approved. Come any weekday, 8&nbsp;AM to 6&nbsp;PM, within the next ${FREE_DAY_LAPSE_DAYS} days.</p>
        <p>When you&rsquo;re here, open this page and get your door code. It works on both doors until 6&nbsp;PM that day.</p>
        ${button(`${base}/freeday`, "Get my door code")}
        <p>You&rsquo;ll sign in with your email (no password: we send a one-time link).</p>
        ${ARRIVAL_HTML}`,
    text: `Hi ${first.text},\n\nYour free day at RegenHub is approved. Come any weekday, 8 AM to 6 PM, within the next ${FREE_DAY_LAPSE_DAYS} days.\n\nWhen you're here, open this page and get your door code. It works on both doors until 6 PM that day:\n${base}/freeday\n\nYou'll sign in with your email (no password: we send a one-time link).\n\n${ARRIVAL_TEXT}`,
  };
}

/** Sent when a free-day claim is approved (web: People → Free days; bot: "Free day only"; or an invite link). */
export function freeDayApprovedEmail(args: { name: string; siteUrl: string }): EmailTemplate {
  const first = firstNameOf(args.name);
  const body = approvedBody(first, siteBase(args.siteUrl));
  return {
    subject: "Your free day at RegenHub is ready",
    html: shell(`        ${body.html}
        <p>Any questions, just reply. A person reads these.</p>
        <p>See you soon,<br>RegenHub</p>`),
    text: `${body.text}\n\nAny questions, just reply. A person reads these.\n\nSee you soon,\nRegenHub`,
  };
}

/** Sent when a free-day claim is approved and the person is also cleared to join ("Free day + Membership"). */
export function freeDayPlusMembershipApprovedEmail(args: { name: string; siteUrl: string }): EmailTemplate {
  const first = firstNameOf(args.name);
  const base = siteBase(args.siteUrl);
  const body = approvedBody(first, base);
  return {
    subject: "Your free day at RegenHub, and membership when you want it",
    html: shell(`        ${body.html}
        <p style="margin-top: 24px;">You&rsquo;re also cleared to join whenever you like. Membership starts at ${MEMBERSHIP_FROM} a month: ${link(`${base}/membership`, "see the plans")}.</p>
        <p>Any questions, just reply. A person reads these.</p>
        <p>See you soon,<br>RegenHub</p>`),
    text: `${body.text}\n\nYou're also cleared to join whenever you like. Membership starts at ${MEMBERSHIP_FROM} a month: ${base}/membership\n\nAny questions, just reply. A person reads these.\n\nSee you soon,\nRegenHub`,
  };
}

/** Sent when a free-day claim arrives and needs a person to look at it (no invite link). */
export function freeDayReceivedEmail(args: { name: string; siteUrl: string }): EmailTemplate {
  const first = firstNameOf(args.name);
  const base = siteBase(args.siteUrl);
  return {
    subject: "We got your free day request",
    html: shell(`        <p>Hi ${first.html},</p>
        <p>Thanks for asking for a free day at RegenHub. A member will look at it soon, and we&rsquo;ll email you when it&rsquo;s approved. Then you can come any weekday.</p>
        <p>You can check where it stands at ${link(`${base}/freeday`, "regenhub.xyz/freeday")}.</p>
        <p>RegenHub</p>`),
    text: `Hi ${first.text},\n\nThanks for asking for a free day at RegenHub. A member will look at it soon, and we'll email you when it's approved. Then you can come any weekday.\n\nYou can check where it stands at ${base}/freeday\n\nRegenHub`,
  };
}

/**
 * Sent instead of a claim when the form is sent signed out with a member's email: the page answers as for any
 * request, so nobody learns from it who is a member; the address's owner learns it here.
 */
export function freeDayAlreadyMemberEmail(args: { name: string; siteUrl: string }): EmailTemplate {
  const first = firstNameOf(args.name);
  const base = siteBase(args.siteUrl);
  return {
    subject: "You don't need a free day",
    html: shell(`        <p>Hi ${first.html},</p>
        <p>Someone asked for a free day at RegenHub with this email. You&rsquo;re already a member, so there&rsquo;s nothing to approve: your door code is on your portal.</p>
        ${button(`${base}/portal`, "Go to my portal")}
        <p>If that wasn&rsquo;t you, you can ignore this email.</p>
        <p>RegenHub</p>`),
    text: `Hi ${first.text},\n\nSomeone asked for a free day at RegenHub with this email. You're already a member, so there's nothing to approve: your door code is on your portal.\n\n${base}/portal\n\nIf that wasn't you, you can ignore this email.\n\nRegenHub`,
  };
}

/** Sent when a pending free-day claim is turned down. */
export function freeDayDeclinedEmail(args: { name: string; siteUrl: string }): EmailTemplate {
  const first = firstNameOf(args.name);
  const base = siteBase(args.siteUrl);
  return {
    subject: "About your free day request",
    html: shell(`        <p>Hi ${first.html},</p>
        <p>Thank you for asking for a free day at RegenHub. We can&rsquo;t offer you one this time.</p>
        <p>You&rsquo;re still welcome at our nights, which are open to everyone: ${link(`${base}/events`, "see what&rsquo;s coming up")}. 420 Happy Hour is every Friday at 4:20.</p>
        <p>If you have a question about it, just reply. A person reads these.</p>
        <p>RegenHub</p>`),
    text: `Hi ${first.text},\n\nThank you for asking for a free day at RegenHub. We can't offer you one this time.\n\nYou're still welcome at our nights, which are open to everyone: ${base}/events. 420 Happy Hour is every Friday at 4:20.\n\nIf you have a question about it, just reply. A person reads these.\n\nRegenHub`,
  };
}

/**
 * Sent when a membership application is approved at the standard rate (bot "Approve", web Applications): they choose
 * a plan at /membership.
 */
export function membershipApprovedEmail(args: { name: string; siteUrl: string }): EmailTemplate {
  const first = firstNameOf(args.name);
  const base = siteBase(args.siteUrl);
  const p = PLAN_MONTHLY_CENTS;
  const plans: [string, string][] = [
    [`${dollars(p.member_basic)} a month`, "one coworking day a month, the member nights and demos"],
    [`${dollars(p.member_2day)} a month`, "two days a month"],
    [`${dollars(p.member_5day)} a month`, "five days a month"],
    [`Hot desk, ${dollars(p.hot_desk)} a month`, "every day, 24/7, your own door code"],
    [`Cold desk, ${dollars(p.cold_desk)} a month`, "a desk of your own, 24/7, your own door code"],
  ];
  return {
    subject: "You're cleared to join RegenHub",
    html: shell(`        <p>Hi ${first.html},</p>
        <p>You&rsquo;re approved to join RegenHub whenever you&rsquo;re ready. The plans:</p>
        <ul style="line-height: 1.7; padding-left: 20px;">
          ${plans.map(([a, b]) => `<li><strong>${a}</strong>: ${b}</li>`).join("\n          ")}
        </ul>
        <p>Days you don&rsquo;t use carry over. Members pay ${dollars(DAY_PASS_MEMBER_CENTS)} for an extra day pass.</p>
        ${button(`${base}/membership`, "Choose a plan")}
        <p>Any questions, just reply.</p>
        <p>RegenHub</p>`),
    text: `Hi ${first.text},\n\nYou're approved to join RegenHub whenever you're ready. The plans:\n\n${plans.map(([a, b]) => `- ${a}: ${b}`).join("\n")}\n\nDays you don't use carry over. Members pay ${dollars(DAY_PASS_MEMBER_CENTS)} for an extra day pass.\n\nChoose a plan: ${base}/membership\n\nAny questions, just reply.\n\nRegenHub`,
  };
}
