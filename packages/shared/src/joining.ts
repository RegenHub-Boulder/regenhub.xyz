/**
 * One way to join (T-482 round 5): apply, one member vouches, one approval, then the person picks a day plan.
 *
 * This file is the one code path for both places a member acts: the members' chat (apps/bot) and the site (portal,
 * People → Applications). Vouching and approving are SQL functions (migration 072: vouch_for_application,
 * approve_application), each one transaction with its audit row; these wrappers call them, turn refusals into words,
 * send the approval email and keep the chat card up to date. The chat cards for applications and free days, and the
 * one "still waiting" re-post at 12 hours, live here too, so the bot and the site post the same card.
 */
import { membershipApprovedEmail, type EmailTemplate } from "./freeDayEmails.js";

/** The subset of a Supabase client these functions use (the bot's and the web's service clients both fit). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JoinDb = { rpc: (name: string, args?: Record<string, unknown>) => any; from: (table: string) => any };

type DbError = { code?: string; message: string } | null;

/** A refusal code from migration 072's functions, or "waiting_for_072" when the functions aren't there yet. */
export type JoinRefusal =
  | "not_found" | "not_pending" | "not_a_member" | "own_application" | "no_vouch" | "not_allowed" | "waiting_for_072" | "failed";

export const JOIN_REFUSAL_WORDS: Record<JoinRefusal, string> = {
  not_found: "That application isn't there any more.",
  not_pending: "That application was already decided.",
  not_a_member: "Only a member can vouch.",
  own_application: "You can't vouch for yourself.",
  no_vouch: "A member needs to vouch for them first.",
  not_allowed: "Only a steward can approve.",
  waiting_for_072: "Vouching and approving start once migration 072 runs.",
  failed: "Something went wrong. Try again, or use People → Applications.",
};

const REFUSALS = new Set<JoinRefusal>(["not_found", "not_pending", "not_a_member", "own_application", "no_vouch", "not_allowed"]);

function refusalOf(error: DbError): JoinRefusal {
  if (!error) return "failed";
  if (error.code === "PGRST202" || error.code === "42883") return "waiting_for_072";
  const code = (error.message ?? "").trim() as JoinRefusal;
  if (REFUSALS.has(code)) return code;
  console.error("[joining] database error:", error.code, error.message);
  return "failed";
}

export type JoinOutcome<T> = ({ ok: true } & T) | { ok: false; reason: JoinRefusal; message: string };

const refuse = <T>(reason: JoinRefusal): JoinOutcome<T> => ({ ok: false, reason, message: JOIN_REFUSAL_WORDS[reason] });

/** A member vouches for a pending application. `already` = someone had vouched; the first vouch stays. */
export async function vouchForApplication(db: JoinDb, applicationId: number, memberId: number): Promise<JoinOutcome<{ already: boolean }>> {
  const { data, error } = await db.rpc("vouch_for_application", { p_application: applicationId, p_member: memberId });
  if (error) return refuse(refusalOf(error));
  return { ok: true, already: data === "already" };
}

export interface ApprovalEmail extends EmailTemplate {
  kind: "membership_approved";
  to: string;
}

/**
 * The one approval (bot card and People → Applications both call this). Needs a vouch and an approver who may
 * approve; then the person is a member and picks a day plan themselves. Sends the approval email through `send`
 * (each app's own sender, so it lands in email_log) unless it was already approved.
 */
export async function approveApplication(
  db: JoinDb,
  args: { applicationId: number; approverMemberId: number; via: "chat" | "site"; siteUrl: string; send: (mail: ApprovalEmail) => Promise<boolean> },
): Promise<JoinOutcome<{ memberId: number; name: string; email: string; already: boolean; emailSent: boolean }>> {
  const { data, error } = await db.rpc("approve_application", {
    p_application: args.applicationId, p_approver: args.approverMemberId, p_via: args.via,
  });
  if (error) return refuse(refusalOf(error));
  const row = data as { member_id: number; name: string; email: string; already: boolean };
  let emailSent = false;
  if (!row.already) {
    const tpl = membershipApprovedEmail({ name: row.name, siteUrl: args.siteUrl });
    emailSent = await args.send({ kind: "membership_approved", to: row.email, ...tpl }).catch(() => false);
  }
  return { ok: true, memberId: row.member_id, name: row.name, email: row.email, already: row.already, emailSent };
}

// ── The chat ────────────────────────────────────────────────────────────────

/** Telegram's legacy Markdown: escape what it would read as formatting. */
export const md = (s: string) => s.replace(/([_*`[])/g, "\\$1");

/** Call the Telegram Bot API (the token and group from env, as both apps have them). Null on any failure. */
export async function telegramApi<T = unknown>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!json?.ok) {
      console.error(`[chat] ${method} failed:`, json?.description ?? res.status);
      return null;
    }
    return json.result ?? null;
  } catch (err) {
    console.error(`[chat] ${method} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export const groupChatId = () => process.env.TELEGRAM_GROUP_CHAT_ID || null;

type Button = { text: string; callback_data?: string; url?: string };
export interface ChatCard { text: string; reply_markup?: { inline_keyboard: Button[][] } }

export interface ApplicationCardFacts {
  id: number;
  name: string;
  email: string;
  status: string;
  about?: string | null;
  how_found?: string | null;
  why_join?: string | null;
  /** "Who here knows you?": the member they named, or null for "nobody yet". */
  knownBy?: { name: string; telegram?: string | null } | null;
  vouchedBy?: { name: string; at: string } | null;
  approvedBy?: string | null;
  /** Set on the 12 h re-post: how long it has waited. */
  waitingHours?: number | null;
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Denver", month: "short", day: "numeric" });

/** The members' chat card for an application, in its current state: vouch, then approve, then done. */
export function applicationCard(f: ApplicationCardFacts, siteUrl = "https://regenhub.xyz"): ChatCard {
  const base = siteUrl.replace(/\/+$/, "");
  const lines: string[] = [];
  if (f.waitingHours) lines.push(`⏰ *Still waiting* (${f.waitingHours} h). We answer within a day.`, ``);
  lines.push(`📋 *Wants to join:* ${md(f.name)}`, md(f.email));
  if (f.about) lines.push(``, `_Works on:_ ${md(f.about)}`);
  if (f.how_found) lines.push(`_Found us:_ ${md(f.how_found)}`);
  if (f.why_join && !f.about) lines.push(``, md(f.why_join));
  lines.push(``);
  if (f.knownBy) {
    const handle = f.knownBy.telegram ? ` (@${md(f.knownBy.telegram.replace(/^@+/, ""))})` : "";
    lines.push(`Says ${md(f.knownBy.name)}${handle} knows them.`);
  } else {
    lines.push(`Says nobody here knows them yet; they'll come to a night or a free day first.`);
  }
  if (f.vouchedBy) lines.push(`🤝 Vouched for by ${md(f.vouchedBy.name)}, ${shortDate(f.vouchedBy.at)}.`);
  else if (f.status === "pending") lines.push(`Needs one member to vouch: tap *I know them* if you've met them.`);

  const open: Button = { text: "Open", url: `${base}/admin/people?tab=applications` };
  let keyboard: Button[][] | undefined;
  if (f.status === "approved") lines.push(``, `✅ *Approved*${f.approvedBy ? ` by ${md(f.approvedBy)}` : ""}. They pick a day plan themselves.`);
  else if (f.status === "rejected") lines.push(``, `Not approved.`);
  else if (f.status === "closed") lines.push(``, `Closed.`);
  else if (!f.vouchedBy) keyboard = [[{ text: "🤝 I know them", callback_data: `app_vouch_${f.id}` }, open]];
  else keyboard = [[{ text: "✅ Approve", callback_data: `app_approve_${f.id}` }, open]];
  return { text: lines.join("\n"), ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) };
}

export interface FreeDayCardFacts {
  id: number;
  name: string;
  email: string;
  status: string;
  telegram?: string | null;
  about?: string | null;
  why_join?: string | null;
  know_at_hub?: string | null;
  /** Approved at once by the free-day rule: why ("came to a night", "invited by Carey", "on our list since Oct 2"). */
  approvedBecause?: string | null;
  approvedBy?: string | null;
  waitingHours?: number | null;
}

/** The members' chat card for a free day: one tap to approve when it waits, a note when the rule approved it. */
export function freeDayCard(f: FreeDayCardFacts): ChatCard {
  const lines: string[] = [];
  if (f.waitingHours) lines.push(`⏰ *Still waiting* (${f.waitingHours} h). We answer within a day.`, ``);
  lines.push(`🎟️ *Free day:* ${md(f.name)}`, md(f.email));
  if (f.telegram) lines.push(`Telegram: @${md(f.telegram.replace(/^@+/, ""))}`);
  if (f.know_at_hub) lines.push(`Knows: ${md(f.know_at_hub)}`);
  if (f.about) lines.push(``, `_Works on:_ ${md(f.about)}`);
  if (f.why_join) lines.push(`_Why:_ ${md(f.why_join)}`);
  if (f.approvedBecause) {
    lines.push(``, `✅ Approved at once: ${md(f.approvedBecause)}. Met them on their free day? Vouch when they apply.`);
    return { text: lines.join("\n") };
  }
  if (f.status !== "pending") {
    lines.push(``, `✅ Approved${f.approvedBy ? ` by ${md(f.approvedBy)}` : ""}.`);
    return { text: lines.join("\n") };
  }
  return {
    text: lines.join("\n"),
    reply_markup: { inline_keyboard: [[{ text: "✅ Approve free day", callback_data: `freeday_approve_${f.id}` }]] },
  };
}

/** Post a card to the members' chat; the new message's id, or null. */
export async function postCard(card: ChatCard): Promise<number | null> {
  const chat = groupChatId();
  if (!chat) return null;
  const sent = await telegramApi<{ message_id: number }>("sendMessage", {
    chat_id: chat, text: card.text, parse_mode: "Markdown", disable_web_page_preview: true,
    ...(card.reply_markup ? { reply_markup: card.reply_markup } : {}),
  });
  return sent?.message_id ?? null;
}

/** Edit a card in place (the buttons go when there's nothing left to tap). */
export async function editCard(target: { chatId: string | number; messageId: number }, card: ChatCard): Promise<boolean> {
  const done = await telegramApi("editMessageText", {
    chat_id: target.chatId, message_id: target.messageId, text: card.text, parse_mode: "Markdown",
    disable_web_page_preview: true, reply_markup: card.reply_markup ?? { inline_keyboard: [] },
  });
  return done != null;
}

const missingColumn = (e: DbError) => !!e && (e.code === "42703" || e.code === "PGRST204");

/** Everything an application's card shows, read fresh. Null when it isn't there. */
export async function applicationCardFacts(db: JoinDb, applicationId: number): Promise<(ApplicationCardFacts & { chatMessageId: number | null }) | null> {
  const { data: app } = await db.from("applications").select("*").eq("id", applicationId).maybeSingle();
  if (!app) return null;
  const ids = [app.known_by_member_id, app.vouched_by, app.approved_by].filter((x: unknown): x is number => typeof x === "number");
  const people = new Map<number, { name: string; telegram_username: string | null }>();
  if (ids.length) {
    const { data } = await db.from("members").select("id, name, telegram_username").in("id", ids);
    for (const m of (data ?? []) as { id: number; name: string; telegram_username: string | null }[]) people.set(m.id, m);
  }
  const known = app.known_by_member_id ? people.get(app.known_by_member_id) : null;
  const voucher = app.vouched_by ? people.get(app.vouched_by) : null;
  return {
    id: app.id, name: app.name, email: app.email, status: app.status,
    about: app.about, how_found: app.how_found ?? null, why_join: app.why_join,
    knownBy: known ? { name: known.name, telegram: known.telegram_username } : null,
    vouchedBy: voucher && app.vouched_at ? { name: voucher.name, at: app.vouched_at } : null,
    approvedBy: app.approved_by ? people.get(app.approved_by)?.name ?? null : null,
    chatMessageId: app.chat_message_id != null ? Number(app.chat_message_id) : null,
  };
}

/** Post a new application's card and remember its message, so a vouch or approval on the site can update it. */
export async function postApplicationCard(db: JoinDb, applicationId: number, siteUrl?: string): Promise<number | null> {
  const facts = await applicationCardFacts(db, applicationId);
  if (!facts) return null;
  const messageId = await postCard(applicationCard(facts, siteUrl));
  if (messageId != null) {
    const { error } = await db.from("applications").update({ chat_message_id: messageId }).eq("id", applicationId);
    if (error && !missingColumn(error)) console.error("[chat] couldn't save the card's message id:", error.message);
  }
  return messageId;
}

/**
 * Bring an application's card up to date after a vouch or an approval. `target` is the message tapped in the chat
 * (the bot passes it); otherwise the card the site posted, if it remembered one.
 */
export async function refreshApplicationCard(db: JoinDb, applicationId: number, target?: { chatId: string | number; messageId: number }, siteUrl?: string): Promise<boolean> {
  const facts = await applicationCardFacts(db, applicationId);
  if (!facts) return false;
  const chat = groupChatId();
  const where = target ?? (facts.chatMessageId != null && chat ? { chatId: chat, messageId: facts.chatMessageId } : null);
  if (!where) return false;
  return editCard(where, applicationCard(facts, siteUrl));
}

/** A card waits this long before it is posted again, once, with "still waiting". */
export const REPOST_AFTER_HOURS = 12;
/** We answer within a day: Today shows anything waiting longer as late. */
export const ANSWER_WITHIN_HOURS = 24;
/** Only cards from the last few days are re-posted, so a deploy doesn't flood the chat with old ones. */
const REPOST_LOOKBACK_HOURS = 72;

/**
 * The one re-post: each application or free-day claim still waiting REPOST_AFTER_HOURS after it came in is posted
 * again, once, with how long it has waited. Claimed with a conditional update first, so two runs can't both post it.
 * Run by the bot's scheduler. Before migration 072 the column is missing and this does nothing.
 */
export async function repostWaitingCards(db: JoinDb, now = new Date(), post: (card: ChatCard) => Promise<number | null> = postCard, siteUrl?: string) {
  const due = new Date(now.getTime() - REPOST_AFTER_HOURS * 3_600_000).toISOString();
  const floor = new Date(now.getTime() - REPOST_LOOKBACK_HOURS * 3_600_000).toISOString();
  const hours = (iso: string) => Math.floor((now.getTime() - Date.parse(iso)) / 3_600_000);
  let applications = 0, freeDays = 0;

  const { data: apps, error: appErr } = await db.from("applications").select("id, created_at")
    .eq("status", "pending").is("chat_reposted_at", null).lte("created_at", due).gte("created_at", floor);
  if (missingColumn(appErr)) return { applications, freeDays, waitingFor: "072_one_approval.sql" };
  if (appErr) throw new Error(`re-post read failed: ${appErr.message}`);
  for (const a of (apps ?? []) as { id: number; created_at: string }[]) {
    const { data: claimed } = await db.from("applications").update({ chat_reposted_at: now.toISOString() })
      .eq("id", a.id).is("chat_reposted_at", null).eq("status", "pending").select("id");
    if (!(claimed ?? []).length) continue;
    const facts = await applicationCardFacts(db, a.id);
    if (!facts) continue;
    const messageId = await post(applicationCard({ ...facts, waitingHours: hours(a.created_at) }, siteUrl));
    if (messageId != null) await db.from("applications").update({ chat_message_id: messageId }).eq("id", a.id);
    applications += 1;
  }

  const { data: claims, error: claimErr } = await db.from("free_day_claims")
    .select("id, name, email, status, telegram, about, why_join, know_at_hub, created_at")
    .eq("status", "pending").is("chat_reposted_at", null).lte("created_at", due).gte("created_at", floor);
  if (claimErr) throw new Error(`re-post read failed: ${claimErr.message}`);
  for (const c of (claims ?? []) as (FreeDayCardFacts & { created_at: string })[]) {
    const { data: claimed } = await db.from("free_day_claims").update({ chat_reposted_at: now.toISOString() })
      .eq("id", c.id).is("chat_reposted_at", null).eq("status", "pending").select("id");
    if (!(claimed ?? []).length) continue;
    await post(freeDayCard({ ...c, waitingHours: hours(c.created_at) }));
    freeDays += 1;
  }
  return { applications, freeDays };
}
