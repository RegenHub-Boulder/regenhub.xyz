/**
 * One way to join (T-482 round 5): apply, one member vouches, one approval, then the person picks a day plan.
 *
 * This file is the one code path for both places a member acts: the members' chat (apps/bot) and the site (portal,
 * People → Applications). Vouching and approving are SQL functions (migration 072: vouch_for_application,
 * approve_application), each one transaction with its audit row; these wrappers call them, turn refusals into words,
 * send the approval email and keep the chat card up to date. The chat cards for applications and free days, and the
 * one "still waiting" re-post at 12 hours, live here too, so the bot and the site post the same card.
 */
import { freeDayApprovedEmail, membershipApprovedEmail, type EmailTemplate } from "./freeDayEmails.js";
import { readUsuallyHere } from "./firstVisitWords.js";

/** The subset of a Supabase client these functions use (the bot's and the web's service clients both fit). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JoinDb = { rpc: (name: string, args?: Record<string, unknown>) => any; from: (table: string) => any };

type DbError = { code?: string; message: string } | null;

/** A refusal code from migration 072's functions, or "waiting_for_072" when the functions aren't there yet. */
export type JoinRefusal =
  | "not_found" | "not_pending" | "not_a_member" | "not_coop" | "own_application" | "no_vouch" | "not_allowed"
  | "not_members_chat" | "chat_not_allowed" | "chat_waiting_for_074" | "waiting_for_072" | "waiting_for_074" | "failed";

export const JOIN_REFUSAL_WORDS: Record<JoinRefusal, string> = {
  not_found: "That application isn't there any more.",
  not_pending: "That application was already decided.",
  not_a_member: "Only a member can vouch.",
  own_application: "You can't vouch for yourself.",
  no_vouch: "A member needs to vouch for them first.",
  not_coop: "On the site, co-op members vouch. Know them? Tap I know them on their card in the members' chat.",
  not_allowed: "On the site, co-op members approve. Anyone in the members' chat can approve there.",
  not_members_chat: "Approving and vouching happen in the members' chat.",
  waiting_for_072: "Vouching and approving start once migration 072 runs.",
  chat_not_allowed: "This account can't approve: it's switched off on the site.",
  chat_waiting_for_074: "Until migration 074 runs, a site admin approves from the chat; then anyone here can.",
  waiting_for_074: "Link your Telegram on your portal profile first: approving from the chat without a link starts once migration 074 runs.",
  failed: "Something went wrong. Try again, or use People → Applications.",
};

const REFUSALS = new Set<JoinRefusal>(["not_found", "not_pending", "not_a_member", "not_coop", "own_application", "no_vouch", "not_allowed"]);

const missingFunction = (error: DbError) => !!error && (error.code === "PGRST202" || error.code === "42883");

function refusalOf(error: DbError): JoinRefusal {
  if (!error) return "failed";
  if (missingFunction(error)) return "waiting_for_072";
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
): Promise<JoinOutcome<ApprovedOutcome>> {
  const { data, error } = await db.rpc("approve_application", {
    p_application: args.applicationId, p_approver: args.approverMemberId, p_via: args.via,
  });
  if (error) return refuse(refusalOf(error));
  return approved(data, args);
}

type ApprovedOutcome = { memberId: number; name: string; email: string; already: boolean; emailSent: boolean };

/** After an approval: the approval email (unless it was approved before), and what happened. */
async function approved(data: unknown, args: { siteUrl: string; send: (mail: ApprovalEmail) => Promise<boolean> }): Promise<JoinOutcome<ApprovedOutcome>> {
  const row = data as { member_id: number; name: string; email: string; already: boolean };
  let emailSent = false;
  if (!row.already) {
    const tpl = membershipApprovedEmail({ name: row.name, siteUrl: args.siteUrl });
    emailSent = await args.send({ kind: "membership_approved", to: row.email, ...tpl }).catch(() => false);
  }
  return { ok: true, memberId: row.member_id, name: row.name, email: row.email, already: row.already, emailSent };
}

// ── Who may approve (T-482, migration 074) ─────────────────────────────────
//
// Aaron, 11-24: "any member in the core group (telegram) can approve. I think on the website, they need to be a
// co-op member." Two doors:
//   - the members' chat (TELEGRAM_GROUP_CHAT_ID): anyone in it, checked here by the chat a tap came from
//     (`isMembersChat`); the tapper is recorded by their linked member row, else their Telegram id and @username;
//   - the site: a co-op member (the web's lib/approval.ts canApproveOnSite; 074's member_can_approve in SQL).

/** Whoever tapped a button in the chat: their Telegram identity, and their member row when their Telegram is linked. */
export interface ChatTapper {
  telegramId: number;
  username: string | null;
  memberId: number | null;
}

/** Did this tap come from the members' chat (the one configured chat), not a DM, another group or a forward? */
export function isMembersChat(chatId: number | string | null | undefined): boolean {
  const core = groupChatId();
  return !!core && chatId != null && String(chatId).trim() === core.trim();
}

/** How an approver or voucher reads on a card or an admin page: their name, or "@username in the chat". */
export function approverWords(by: { name?: string | null; telegram?: string | null } | null | undefined): string | null {
  if (by?.name) return by.name;
  const handle = by?.telegram?.replace(/^@+/, "").trim();
  return handle ? `@${handle} in the chat` : null;
}

const tapperArgs = (t: ChatTapper) => ({
  p_telegram_id: t.telegramId, p_telegram_username: t.username, p_member: t.memberId,
});

/**
 * Someone in the members' chat taps "I know them". The caller checked `isMembersChat`. Before 074 a linked member
 * vouches through 072's function and an unlinked tapper is told to link first.
 */
/** The chat's words for a refusal: not_allowed there means a switched-off account (074), or 072's rule before it. */
function inChat<T>(out: JoinOutcome<T>, before074 = false): JoinOutcome<T> {
  if (out.ok || out.reason !== "not_allowed") return out;
  return refuse(before074 ? "chat_waiting_for_074" : "chat_not_allowed");
}

export async function vouchInChat(db: JoinDb, applicationId: number, tapper: ChatTapper): Promise<JoinOutcome<{ already: boolean }>> {
  const { data, error } = await db.rpc("chat_vouch_for_application", { p_application: applicationId, ...tapperArgs(tapper) });
  if (missingFunction(error)) {
    if (tapper.memberId == null) return refuse("waiting_for_074");
    return inChat(await vouchForApplication(db, applicationId, tapper.memberId), true);
  }
  if (error) return inChat(refuse(refusalOf(error)));
  return { ok: true, already: data === "already" };
}

type ApproveArgs = { applicationId: number; siteUrl: string; send: (mail: ApprovalEmail) => Promise<boolean> };

/**
 * Someone in the members' chat taps Approve. The caller checked `isMembersChat`. Same approval as the site's
 * (074's approve_application_core); before 074 a linked member goes through 072's rule (a site admin).
 */
export async function approveInChat(db: JoinDb, args: ApproveArgs & { tapper: ChatTapper }) {
  const { data, error } = await db.rpc("chat_approve_application", { p_application: args.applicationId, ...tapperArgs(args.tapper) });
  if (missingFunction(error)) {
    if (args.tapper.memberId == null) return refuse<ApprovedOutcome>("waiting_for_074");
    return inChat(await approveApplication(db, { ...args, approverMemberId: args.tapper.memberId, via: "chat" }), true);
  }
  if (error) return inChat(refuse<ApprovedOutcome>(refusalOf(error)));
  return approved(data, args);
}

export type FreeDayApprover = { site: { memberId: number; name: string } } | { chat: ChatTapper & { firstName?: string | null } };

/**
 * Approve a free day: pending → reserved, who approved, and the audit row (074's approve_free_day /
 * chat_approve_free_day). `already` = it wasn't pending any more, so no email goes. The site's caller checked
 * canApproveOnSite, the chat's `isMembersChat`; before 074 this is the old conditional update with who approved.
 */
export async function approveFreeDay(db: JoinDb, claimId: number, by: FreeDayApprover):
  Promise<JoinOutcome<{ name: string; email: string; already: boolean; status: string }>> {
  const { data, error } = "site" in by
    ? await db.rpc("approve_free_day", { p_claim: claimId, p_member: by.site.memberId })
    : await db.rpc("chat_approve_free_day", { p_claim: claimId, ...tapperArgs(by.chat) });
  if (!missingFunction(error)) {
    if (error) return "chat" in by ? inChat(refuse(refusalOf(error))) : refuse(refusalOf(error));
    const row = data as { name: string; email: string; already: boolean; status: string };
    return { ok: true, ...row };
  }
  // Before 074: the update the bot and the admin page made, conditional on pending so two taps can't both email.
  const words = "site" in by ? by.site.name
    : by.chat.username ? `@${by.chat.username.replace(/^@+/, "")}` : by.chat.firstName ?? null;
  const { data: claim } = await db.from("free_day_claims").select("id, name, email, status").eq("id", claimId).maybeSingle();
  if (!claim) return refuse("not_found");
  if (claim.status !== "pending") return { ok: true, name: claim.name, email: claim.email, already: true, status: claim.status };
  const { data: moved, error: moveErr } = await db.from("free_day_claims").update({ status: "reserved", approved_by: words })
    .eq("id", claimId).eq("status", "pending").select("id");
  if (moveErr) return refuse(refusalOf(moveErr));
  if (!(moved ?? []).length) return { ok: true, name: claim.name, email: claim.email, already: true, status: "reserved" };
  return { ok: true, name: claim.name, email: claim.email, already: false, status: "reserved" };
}

/** A tap on a card's button, as the bot sees it. */
export interface ChatTap {
  data: string;
  /** The chat the tapped message is in; null when Telegram sent no message (an inline-mode message). */
  chatId: number | string | null;
  messageId: number | null;
  /** The message's text, for the free-day card's "approved by" line. */
  messageText?: string | null;
  from: { id: number; username?: string | null; first_name?: string | null };
}

export interface ChatTapDeps {
  /** The tapper's member row when their Telegram is linked (the bot's resolveSender, disabled rows included), else null. */
  memberFor: (from: ChatTap["from"]) => Promise<{ id: number } | null>;
  /** Each app's own sender, so the mail lands in email_log. */
  send: (mail: (ApprovalEmail | (EmailTemplate & { kind: "free_day_approved"; to: string }))) => Promise<boolean>;
  siteUrl: string;
}

/**
 * The chat card buttons: "I know them" and Approve on an application, Approve on a free day. Anyone in the members'
 * chat may tap them; a tap from anywhere else is refused (`isMembersChat`). Returns whether the tap was one of these
 * (false = not ours, the bot carries on) and a line to post back in the chat, if any. The card itself is edited here.
 */
export async function handleApprovalTap(db: JoinDb, tap: ChatTap, deps: ChatTapDeps): Promise<{ handled: boolean; reply?: string }> {
  const isApp = /^app_(vouch|approve)_\d+$/.test(tap.data);
  const isFreeDay = /^freeday_approve_(membership_)?\d+$/.test(tap.data);
  if (!isApp && !isFreeDay) return { handled: false };
  if (!isMembersChat(tap.chatId)) return { handled: true, reply: JOIN_REFUSAL_WORDS.not_members_chat };

  const member = await deps.memberFor(tap.from);
  const tapper: ChatTapper = { telegramId: tap.from.id, username: tap.from.username || null, memberId: member?.id ?? null };
  const target = tap.chatId != null && tap.messageId != null ? { chatId: tap.chatId, messageId: tap.messageId } : undefined;
  const id = Number(tap.data.replace(/^\D+/, ""));

  if (isFreeDay) {
    // One button: a free day is only a free day. A card from before T-482 round 5 may still carry
    // "freeday_approve_membership_": it approves the free day only.
    const result = await approveFreeDay(db, id, { chat: { ...tapper, firstName: tap.from.first_name } });
    if (!result.ok) return { handled: true, reply: result.message };
    if (result.already) return { handled: true, reply: `Already ${result.status === "reserved" ? "approved" : result.status}.` };
    const usuallyHere = await readUsuallyHere(db).catch(() => null);
    const tpl = freeDayApprovedEmail({ name: result.name, siteUrl: deps.siteUrl, usuallyHere });
    const sent = await deps.send({ kind: "free_day_approved", to: result.email, ...tpl }).catch(() => false);
    const who = tapper.username ? `@${tapper.username}` : tap.from.first_name ?? "someone";
    if (target) {
      await telegramApi("editMessageText", {
        chat_id: target.chatId, message_id: target.messageId,
        text: `✅ Free day approved by ${who}${sent ? ` · email sent to ${result.email}` : ""}\n\n${tap.messageText ?? ""}`.trim(),
        reply_markup: { inline_keyboard: [] },
      });
    }
    return { handled: true, reply: sent ? undefined : `⚠️ Approved, but the email to ${result.email} didn't send: tell them their free day is ready.` };
  }

  if (tap.data.startsWith("app_vouch_")) {
    const result = await vouchInChat(db, id, tapper);
    if (!result.ok) return { handled: true, reply: result.message };
    await refreshApplicationCard(db, id, target, deps.siteUrl);
    return { handled: true };
  }
  const result = await approveInChat(db, { applicationId: id, siteUrl: deps.siteUrl, send: deps.send, tapper });
  if (!result.ok) return { handled: true, reply: result.message };
  await refreshApplicationCard(db, id, target, deps.siteUrl);
  if (!result.already && !result.emailSent) {
    return { handled: true, reply: `⚠️ Approved, but the email to ${result.email} didn't send: tell them to open their portal to pick a plan.` };
  }
  return { handled: true };
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
  else if (f.status === "pending") lines.push(`Needs one vouch: tap *I know them* if you've met them.`);
  if (f.vouchedBy && f.status === "pending") lines.push(`Anyone here can approve.`);

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
  lines.push(``, `Anyone here can approve.`);
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
  // Who vouched and who approved: the member row, or (074) an unlinked chat member's @username.
  const voucher = approverWords({ name: app.vouched_by ? people.get(app.vouched_by)?.name : null, telegram: app.vouched_by_telegram });
  const approver = approverWords({ name: app.approved_by ? people.get(app.approved_by)?.name : null, telegram: app.approved_by_telegram });
  return {
    id: app.id, name: app.name, email: app.email, status: app.status,
    about: app.about, how_found: app.how_found ?? null, why_join: app.why_join,
    knownBy: known ? { name: known.name, telegram: known.telegram_username } : null,
    vouchedBy: app.vouched_at && (app.vouched_by || app.vouched_by_telegram_id) ? { name: voucher ?? "someone in the chat", at: app.vouched_at } : null,
    approvedBy: approver,
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
