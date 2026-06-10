import { createHmac } from "crypto";
import { createServiceClient } from "@/lib/supabase/admin";
import { fetchUpcomingLumaEvents, type LumaEvent } from "@/lib/luma";
import type { HubDigestStats } from "@/lib/email";

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Newsletter compile + audience logic, shared by the biweekly cron and the
 * admin "preview to me" endpoint so both always produce the same issue.
 */

// ---------- Unsubscribe tokens ----------

/** HMAC of the email keyed off CRON_SECRET. The "unsub:" prefix scopes the
 *  derivation so the token can't be confused with anything else derived from
 *  the same secret. */
export function unsubscribeToken(email: string): string {
  const secret = process.env.CRON_SECRET ?? "dev-secret";
  return createHmac("sha256", secret).update(`unsub:${email.toLowerCase()}`).digest("hex").slice(0, 32);
}

export function unsubscribeUrl(email: string, siteUrl: string): string {
  const base = siteUrl.replace(/\/$/, "");
  return `${base}/api/newsletter/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`;
}

// ---------- ISO week (for issue keys + biweekly parity) ----------

export function isoWeek(date: Date): { year: number; week: number } {
  // Standard ISO-8601 week algorithm
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

export function issueKeyFor(date: Date): string {
  const { year, week } = isoWeek(date);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// ---------- Stats (last 14 days) ----------

export async function compileFortnightStats(admin: ServiceClient): Promise<HubDigestStats> {
  const now = new Date();
  const start = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const startIso = start.toISOString();
  const endIso = now.toISOString();
  const windowLabel = `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  const [
    { data: billingSubs },
    { count: coldDesk },
    { count: hotDesk },
    { count: hubFriend },
    { count: dayPass },
    { count: newMembers },
    { data: visits },
    { count: dayCodesIssued },
    { count: freeDaySignups },
  ] = await Promise.all([
    admin.from("subscriptions").select("monthly_cents, status").in("status", ["active", "trialing"]),
    admin.from("members").select("*", { count: "exact", head: true }).eq("disabled", false).eq("member_type", "cold_desk"),
    admin.from("members").select("*", { count: "exact", head: true }).eq("disabled", false).eq("member_type", "hot_desk"),
    admin.from("members").select("*", { count: "exact", head: true }).eq("disabled", false).eq("member_type", "hub_friend"),
    admin.from("members").select("*", { count: "exact", head: true }).eq("disabled", false).eq("member_type", "day_pass"),
    admin.from("members").select("*", { count: "exact", head: true }).gte("created_at", startIso).lt("created_at", endIso),
    admin.from("access_logs").select("member_id").eq("result", "granted").gte("created_at", startIso).lt("created_at", endIso),
    admin.from("day_codes").select("*", { count: "exact", head: true }).gte("issued_at", startIso).lt("issued_at", endIso),
    admin.from("free_day_claims").select("*", { count: "exact", head: true }).gte("created_at", startIso).lt("created_at", endIso),
  ]);

  return {
    monthLabel: windowLabel,
    mrrCents: (billingSubs ?? []).reduce((s, r) => s + r.monthly_cents, 0),
    payingMembers: (billingSubs ?? []).length,
    tierCounts: [
      { label: "Cold Desk", count: coldDesk ?? 0 },
      { label: "Hot Desk", count: hotDesk ?? 0 },
      { label: "Hub Friend", count: hubFriend ?? 0 },
      { label: "Day Pass", count: dayPass ?? 0 },
    ],
    newMembers: newMembers ?? 0,
    totalVisits: (visits ?? []).length,
    distinctVisitors: new Set((visits ?? []).map((v) => v.member_id).filter(Boolean)).size,
    dayCodesIssued: dayCodesIssued ?? 0,
    freeDaySignups: freeDaySignups ?? 0,
  };
}

// ---------- Audience ----------

export interface Recipient {
  email: string;
  name: string | null;
}

/** Members + interests, deduped, minus unsubscribes. */
export async function compileAudience(admin: ServiceClient): Promise<Recipient[]> {
  const [{ data: members }, { data: interests }, { data: unsubs }] = await Promise.all([
    admin.from("members").select("name, email").eq("disabled", false).not("email", "is", null),
    admin.from("interests").select("name, email").not("email", "is", null),
    admin.from("email_unsubscribes").select("email"),
  ]);

  const blocked = new Set((unsubs ?? []).map((u) => u.email.toLowerCase()));
  const seen = new Map<string, Recipient>();
  for (const m of members ?? []) {
    if (!m.email) continue;
    const key = m.email.toLowerCase();
    if (blocked.has(key)) continue;
    seen.set(key, { email: m.email, name: m.name });
  }
  for (const i of interests ?? []) {
    if (!i.email) continue;
    const key = i.email.toLowerCase();
    if (blocked.has(key) || seen.has(key)) continue;
    seen.set(key, { email: i.email, name: i.name ?? null });
  }
  return Array.from(seen.values());
}

// ---------- The issue itself ----------

export interface CompiledIssue {
  issueKey: string;
  subject: string;
  note: { id: number; text: string; author: string | null } | null;
  stats: HubDigestStats;
  events: LumaEvent[];
}

export async function compileIssue(admin: ServiceClient): Promise<CompiledIssue> {
  const now = new Date();
  const issueKey = issueKeyFor(now);

  const [stats, events, { data: noteRow }] = await Promise.all([
    compileFortnightStats(admin),
    fetchUpcomingLumaEvents(21),
    admin.from("digest_notes").select("id, note, author_member_id").is("consumed_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  let note: CompiledIssue["note"] = null;
  if (noteRow) {
    let author: string | null = null;
    if (noteRow.author_member_id) {
      const { data: a } = await admin.from("members").select("name").eq("id", noteRow.author_member_id).maybeSingle();
      author = a?.name ?? null;
    }
    note = { id: noteRow.id, text: noteRow.note, author };
  }

  const dateLabel = now.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/Denver" });
  return {
    issueKey,
    subject: `RegenHub dispatch — ${dateLabel}`,
    note,
    stats,
    events,
  };
}

// ---------- Render ----------

function eventRow(e: LumaEvent): string {
  const when = new Date(e.startAt).toLocaleDateString("en-US", {
    timeZone: "America/Denver",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `<tr>
    <td style="padding: 6px 14px 6px 0; color: #555; white-space: nowrap; vertical-align: top; font-size: 14px;">${when}</td>
    <td style="padding: 6px 0; font-size: 14px;"><a href="${e.url}" style="color: #2d5e3e; font-weight: 600; text-decoration: none;">${e.name}</a></td>
  </tr>`;
}

export function renderNewsletterHtml(issue: CompiledIssue, recipientEmail: string, siteUrl: string): string {
  const { stats } = issue;
  const base = siteUrl.replace(/\/$/, "");
  const mrr = `$${(stats.mrrCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  const noteHtml = issue.note
    ? `<div style="background: #f0f4f1; border-left: 3px solid #2d5e3e; padding: 14px 18px; margin: 22px 0; border-radius: 0 8px 8px 0;">
        <p style="margin: 0; white-space: pre-wrap;">${issue.note.text}</p>
        ${issue.note.author ? `<p style="margin: 8px 0 0; font-size: 13px; color: #555;">— ${issue.note.author}</p>` : ""}
      </div>`
    : "";

  const eventsHtml = issue.events.length > 0
    ? `<h3 style="margin: 26px 0 8px;">Upcoming at the hub</h3>
       <table style="border-collapse: collapse;">${issue.events.map(eventRow).join("")}</table>
       <p style="font-size: 13px; color: #555; margin-top: 8px;">Full calendar + RSVP: <a href="https://lu.ma/regenhub" style="color: #2d5e3e;">lu.ma/regenhub</a></p>`
    : `<p style="font-size: 14px; color: #555; margin-top: 22px;">Events calendar: <a href="https://lu.ma/regenhub" style="color: #2d5e3e;">lu.ma/regenhub</a></p>`;

  const tierRows = stats.tierCounts
    .map((t) => `<tr><td style="padding: 3px 12px 3px 0; color: #555; font-size: 14px;">${t.label}</td><td style="padding: 3px 0; font-weight: 600; font-size: 14px;">${t.count}</td></tr>`)
    .join("");

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.55;">
      <p style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #2d5e3e; margin-bottom: 4px;">RegenHub dispatch</p>
      <h2 style="margin: 0 0 14px;">News from the cooperative</h2>
      ${noteHtml}
      ${eventsHtml}
      <h3 style="margin: 28px 0 8px;">The numbers (last two weeks)</h3>
      <p style="font-size: 13px; color: #555; margin: 0 0 8px;">As a cooperative, we share the same numbers we look at — ${stats.monthLabel}.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 8px 0;">
        <tr><td style="padding: 3px 12px 3px 0; color: #555; font-size: 14px;">Monthly recurring revenue</td><td style="padding: 3px 0; font-weight: 600; font-size: 14px;">${mrr}</td></tr>
        <tr><td style="padding: 3px 12px 3px 0; color: #555; font-size: 14px;">Paying members</td><td style="padding: 3px 0; font-weight: 600; font-size: 14px;">${stats.payingMembers}</td></tr>
        <tr><td style="padding: 3px 12px 3px 0; color: #555; font-size: 14px;">New members</td><td style="padding: 3px 0; font-weight: 600; font-size: 14px;">${stats.newMembers}</td></tr>
        <tr><td style="padding: 3px 12px 3px 0; color: #555; font-size: 14px;">Door entries</td><td style="padding: 3px 0; font-weight: 600; font-size: 14px;">${stats.totalVisits}</td></tr>
        <tr><td style="padding: 3px 12px 3px 0; color: #555; font-size: 14px;">Day codes issued</td><td style="padding: 3px 0; font-weight: 600; font-size: 14px;">${stats.dayCodesIssued}</td></tr>
        <tr><td style="padding: 3px 12px 3px 0; color: #555; font-size: 14px;">Free-day signups</td><td style="padding: 3px 0; font-weight: 600; font-size: 14px;">${stats.freeDaySignups}</td></tr>
      </table>
      <table style="border-collapse: collapse; margin: 4px 0 12px;">${tierRows}</table>
      <p style="font-size: 14px;">Want to co-work with us? <a href="${base}/freeday" style="color: #2d5e3e;">Claim a free day</a> or <a href="${base}/membership" style="color: #2d5e3e;">see membership tiers</a>.</p>
      <p style="font-size: 14px;">Questions or ideas — just reply, it goes straight to a human.</p>
      <p style="font-size: 14px;">With gratitude,<br>RegenHub<br><span style="color: #888; font-size: 12px;">1515 Walnut St, Suite 200, Boulder, CO</span></p>
      <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0 12px;" />
      <p style="font-size: 11px; color: #999;">
        You're receiving this because you're a RegenHub member or joined our list.
        <a href="${unsubscribeUrl(recipientEmail, siteUrl)}" style="color: #999;">Unsubscribe</a>
      </p>
    </div>
  `;
}

export function renderNewsletterText(issue: CompiledIssue, recipientEmail: string, siteUrl: string): string {
  const { stats } = issue;
  const base = siteUrl.replace(/\/$/, "");
  const mrr = `$${(stats.mrrCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const noteText = issue.note ? `\n${issue.note.text}${issue.note.author ? `\n— ${issue.note.author}` : ""}\n` : "";
  const eventsText = issue.events.length > 0
    ? "\nUPCOMING AT THE HUB\n" + issue.events.map((e) => {
        const when = new Date(e.startAt).toLocaleDateString("en-US", { timeZone: "America/Denver", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        return `  ${when} — ${e.name}\n    ${e.url}`;
      }).join("\n") + "\n\nFull calendar: https://lu.ma/regenhub\n"
    : "\nEvents calendar: https://lu.ma/regenhub\n";
  const tierText = stats.tierCounts.map((t) => `  ${t.label}: ${t.count}`).join("\n");

  return `REGENHUB DISPATCH\n${noteText}${eventsText}\nTHE NUMBERS (${stats.monthLabel})\nMonthly recurring revenue: ${mrr}\nPaying members: ${stats.payingMembers}\nNew members: ${stats.newMembers}\nDoor entries: ${stats.totalVisits}\nDay codes issued: ${stats.dayCodesIssued}\nFree-day signups: ${stats.freeDaySignups}\n\nMembers by tier:\n${tierText}\n\nCome co-work: ${base}/freeday · Membership: ${base}/membership\n\nQuestions or ideas — just reply, it goes straight to a human.\n\nWith gratitude,\nRegenHub\n1515 Walnut St, Suite 200, Boulder, CO\n\nUnsubscribe: ${unsubscribeUrl(recipientEmail, siteUrl)}`;
}
