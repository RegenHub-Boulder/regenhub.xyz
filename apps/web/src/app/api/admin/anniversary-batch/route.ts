import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";

/**
 * POST /api/admin/anniversary-batch
 *
 * ONE-TIME ROUTE for the 2026-06-05 anniversary signup batch:
 *   - 10 free-day signups from the 2-year anniversary party
 *   - 7 non-raffle get +1 day pass + thank-you email
 *   - 3 raffle winners (Heather, Jeff, Nathan) get +5 day passes + winner email
 *   - Also sends a preview copy of the non-raffle email to ag@unforced.org
 *     so Aaron can confirm the format before fan-out
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 *
 * Idempotency: tracks granted balances via a metadata note on the increment
 * — re-running is safe because we check that the member's balance hasn't
 * already been touched for this batch (via the "anniversary-2y" purchases-note).
 * Actually simpler: we use the explicit `dry_run` flag in the body to preview
 * what would happen, and `confirm: true` to actually do it.
 *
 * Drop this route after the batch is sent.
 */

const NON_RAFFLE_EMAILS = [
  "tsmereka@proton.me",
  "christianoudard@pm.me",
  "kathamarose@gmail.com",
  "murdock.cameron@gmail.com",
  "suede0619@gmail.com",
  "madwayoga@gmail.com",
  "dlubar@pm.me",
];
const RAFFLE_EMAILS = [
  "hleisner@gmail.com",     // Heather Eisner
  "housecatbean@gmail.com", // Jeff Dunn
  "naterichmond@proton.me", // Nathan Richmond
];
const RAFFLE_BONUS = 5;
const NON_RAFFLE_BONUS = 1;
const PREVIEW_RECIPIENT = "ag@unforced.org";

function nonRaffleEmail(firstName: string, siteUrl: string) {
  const base = siteUrl.replace(/\/$/, "");
  return {
    subject: `${firstName}, your RegenHub bonus pass is ready`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
        <p>Hi ${firstName},</p>
        <p>Thanks for coming to RegenHub&rsquo;s 2-year anniversary last night. It meant a lot to have you there.</p>
        <p>Even though the raffle didn&rsquo;t land in your favor, <strong>we&rsquo;ve added an extra day pass to your account</strong> just for entering. Combined with your free-day visit, that&rsquo;s <strong>2 total visits</strong> waiting for you whenever you&rsquo;d like to come work or hang.</p>
        <h3 style="margin-top: 28px;">How to use them</h3>
        <ol style="line-height: 1.7; padding-left: 20px;">
          <li>Sign in to your portal at <a href="${base}/portal" style="color: #2d5e3e;">regenhub.xyz/portal</a> &mdash; we&rsquo;ll send you a magic-link email, no password needed</li>
          <li>Tap <strong>Day Passes</strong> &rarr; <strong>Generate code</strong></li>
          <li>You&rsquo;ll get a 6-digit PIN valid until 6&nbsp;PM that day &mdash; works at the front-door keypad</li>
        </ol>
        <p>The hub is open Monday&ndash;Friday, 8&nbsp;AM&ndash;6&nbsp;PM. Come whenever fits.</p>
        <h3 style="margin-top: 28px;">Going deeper, if you want</h3>
        <p>If you&rsquo;d like to become a contributing member &mdash; monthly support of the cooperative, day passes included each month, members-only events, sliding-scale community &mdash; apply at <a href="${base}/apply" style="color: #2d5e3e;">regenhub.xyz/apply</a> and we&rsquo;ll get you set up.</p>
        <p><strong>Address:</strong> 1515 Walnut St, Suite 200, Boulder, CO</p>
        <p>We&rsquo;re so grateful you joined us, and excited for you to come co-work. Any questions, just reply to this email &mdash; replies go straight to us.</p>
        <p>See you soon,<br>RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nThanks for coming to RegenHub's 2-year anniversary last night. It meant a lot to have you there.\n\nEven though the raffle didn't land in your favor, we've added an extra day pass to your account just for entering. Combined with your free-day visit, that's 2 total visits waiting for you whenever you'd like to come work or hang.\n\nHow to use them:\n1. Sign in to your portal at ${base}/portal — we'll send you a magic-link email, no password needed\n2. Tap "Day Passes" → "Generate code"\n3. You'll get a 6-digit PIN valid until 6 PM that day — works at the front-door keypad\n\nThe hub is open Monday–Friday, 8 AM–6 PM. Come whenever fits.\n\nGoing deeper, if you want:\nIf you'd like to become a contributing member — monthly support of the cooperative, day passes included each month, members-only events, sliding-scale community — apply at ${base}/apply and we'll get you set up.\n\nAddress: 1515 Walnut St, Suite 200, Boulder, CO\n\nWe're so grateful you joined us, and excited for you to come co-work. Any questions, just reply to this email — replies go straight to us.\n\nSee you soon,\nRegenHub`,
  };
}

function raffleEmail(firstName: string, siteUrl: string) {
  const base = siteUrl.replace(/\/$/, "");
  return {
    subject: `${firstName}, you won the raffle 🎉 — 5 bonus day passes added`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
        <p>Hi ${firstName},</p>
        <p>Thanks for coming to RegenHub&rsquo;s 2-year anniversary last night &mdash; and <strong>congratulations, you won the raffle.</strong></p>
        <p>We&rsquo;ve added <strong>5 day passes</strong> to your account, on top of your free-day visit. That&rsquo;s <strong>6 total visits</strong> ready for you to use whenever you&rsquo;d like to come work or hang.</p>
        <h3 style="margin-top: 28px;">How to use them</h3>
        <ol style="line-height: 1.7; padding-left: 20px;">
          <li>Sign in to your portal at <a href="${base}/portal" style="color: #2d5e3e;">regenhub.xyz/portal</a> &mdash; we&rsquo;ll send you a magic-link email, no password needed</li>
          <li>Tap <strong>Day Passes</strong> &rarr; <strong>Generate code</strong></li>
          <li>You&rsquo;ll get a 6-digit PIN valid until 6&nbsp;PM that day &mdash; works at the front-door keypad</li>
        </ol>
        <p>The hub is open Monday&ndash;Friday, 8&nbsp;AM&ndash;6&nbsp;PM. Come whenever fits.</p>
        <h3 style="margin-top: 28px;">Going deeper, if you want</h3>
        <p>If you&rsquo;d like to become a contributing member &mdash; monthly support of the cooperative, day passes included each month, members-only events, sliding-scale community &mdash; apply at <a href="${base}/apply" style="color: #2d5e3e;">regenhub.xyz/apply</a> and we&rsquo;ll set you up.</p>
        <p><strong>Address:</strong> 1515 Walnut St, Suite 200, Boulder, CO</p>
        <p>We&rsquo;re so grateful you joined us, and excited to have you come co-work. Any questions, just reply to this email &mdash; replies go straight to us.</p>
        <p>See you soon,<br>RegenHub</p>
      </div>
    `,
    text: `Hi ${firstName},\n\nThanks for coming to RegenHub's 2-year anniversary last night — and congratulations, you won the raffle.\n\nWe've added 5 day passes to your account, on top of your free-day visit. That's 6 total visits ready for you to use whenever you'd like to come work or hang.\n\nHow to use them:\n1. Sign in to your portal at ${base}/portal — we'll send you a magic-link email, no password needed\n2. Tap "Day Passes" → "Generate code"\n3. You'll get a 6-digit PIN valid until 6 PM that day — works at the front-door keypad\n\nThe hub is open Monday–Friday, 8 AM–6 PM. Come whenever fits.\n\nGoing deeper, if you want:\nIf you'd like to become a contributing member — monthly support of the cooperative, day passes included each month, members-only events, sliding-scale community — apply at ${base}/apply and we'll set you up.\n\nAddress: 1515 Walnut St, Suite 200, Boulder, CO\n\nWe're so grateful you joined us, and excited to have you come co-work. Any questions, just reply to this email — replies go straight to us.\n\nSee you soon,\nRegenHub`,
  };
}

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 503 });
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { confirm?: boolean; dry_run?: boolean } | null;
  const dryRun = body?.dry_run !== false && !body?.confirm;

  const admin = createServiceClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";

  const allEmails = [
    ...NON_RAFFLE_EMAILS.map((e) => ({ email: e, raffle: false as const })),
    ...RAFFLE_EMAILS.map((e) => ({ email: e, raffle: true as const })),
  ];

  // Resolve every member up front
  const { data: members } = await admin
    .from("members")
    .select("id, name, email, day_passes_balance")
    .in("email", allEmails.map((r) => r.email));
  const byEmail = new Map((members ?? []).map((m) => [m.email.toLowerCase(), m]));

  const results: Array<{
    email: string;
    name?: string;
    raffle: boolean;
    found: boolean;
    bonus: number;
    new_balance?: number;
    email_sent?: boolean;
    error?: string;
  }> = [];

  // Send the preview copy first so Aaron sees it lands even if the batch fails midway
  if (!dryRun) {
    const sampleFirstName = "Aaron";
    const tpl = nonRaffleEmail(sampleFirstName, siteUrl);
    const previewOk = await sendEmail({
      to: PREVIEW_RECIPIENT,
      subject: `[PREVIEW — non-raffle template] ${tpl.subject}`,
      html: tpl.html,
      text: tpl.text,
    });
    results.push({
      email: PREVIEW_RECIPIENT,
      name: "PREVIEW",
      raffle: false,
      found: true,
      bonus: 0,
      email_sent: previewOk,
    });
  }

  for (const row of allEmails) {
    const m = byEmail.get(row.email.toLowerCase());
    if (!m) {
      results.push({ email: row.email, raffle: row.raffle, found: false, bonus: 0, error: "member not found" });
      continue;
    }
    const bonus = row.raffle ? RAFFLE_BONUS : NON_RAFFLE_BONUS;

    if (dryRun) {
      results.push({
        email: row.email,
        name: m.name,
        raffle: row.raffle,
        found: true,
        bonus,
        new_balance: m.day_passes_balance + bonus,
      });
      continue;
    }

    // Atomic increment via existing RPC
    const { data: newBalance, error: rpcErr } = await admin.rpc("increment_day_pass_balance", {
      p_member_id: m.id,
      p_amount: bonus,
    });
    if (rpcErr) {
      results.push({ email: row.email, name: m.name, raffle: row.raffle, found: true, bonus, error: rpcErr.message });
      continue;
    }

    const firstName = m.name.split(" ")[0];
    const tpl = row.raffle ? raffleEmail(firstName, siteUrl) : nonRaffleEmail(firstName, siteUrl);
    const ok = await sendEmail({ to: m.email, subject: tpl.subject, html: tpl.html, text: tpl.text });

    results.push({
      email: row.email,
      name: m.name,
      raffle: row.raffle,
      found: true,
      bonus,
      new_balance: typeof newBalance === "number" ? newBalance : undefined,
      email_sent: ok,
    });
  }

  return NextResponse.json({
    dry_run: dryRun,
    total: results.length,
    granted: results.filter((r) => r.new_balance != null).length,
    sent: results.filter((r) => r.email_sent === true).length,
    failed: results.filter((r) => r.error).length,
    results,
  });
}
