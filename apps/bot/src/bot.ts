import TelegramBot from "node-telegram-bot-api";
import { db, findMemberByTelegram, findAdminByTelegram, type MemberRow } from "./db/supabase.js";
import { setUserCode, clearUserCode, formatLockWarning } from "./helpers/homeAssistant.js";
import {
  findNextAvailableDayPassSlot,
  findNextMemberSlot,
  generateRandomCode,
  calculateDayPassExpiration,
  calculateExpiration,
} from "./helpers/slotManager.js";

let bot: TelegramBot;

type PendingAction = {
  type: "newcode" | "quickcode" | "addmember" | "addpasses" | "addadmin";
  step: string;
  data: Record<string, unknown>;
  timestamp: number;
};

const pending = new Map<number, PendingAction>();
const ITEMS_PER_PAGE = 10;

async function react(msg: TelegramBot.Message) {
  try {
    await bot.setMessageReaction(msg.chat.id, msg.message_id, {
      reaction: [{ type: "emoji", emoji: "👀" }],
    });
  } catch { /* silent */ }
}

function fmt(date: Date): string {
  return date.toLocaleString("en-US", {
    timeZone: process.env.TIMEZONE ?? "America/Denver",
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

// ── Member commands ─────────────────────────────────────────

async function handleStart(msg: TelegramBot.Message) {
  await react(msg);
  const user = await findMemberByTelegram(msg.from?.username ?? "");
  if (!user) return bot.sendMessage(msg.chat.id, `Your Telegram (@${msg.from?.username}) isn't registered. Contact an admin to get set up.`);

  const isFull = user.member_type !== "day_pass";
  let text = `Welcome back, ${user.name}!\n\n`;
  text += isFull
    ? `/mycode — Your door code\n/newcode — Change your code\n/daypass — Guest code\n/email — Update your email\n/help — Help`
    : `/daypass — Get today's code\n/email — Update your email\n/help — Help`;

  if (user.is_admin) text += `\n\nAdmin:\n/quickcode — Quick code\n/codes — Active codes\n/admin — Manage members`;
  return bot.sendMessage(msg.chat.id, text);
}

async function handleMyCode(msg: TelegramBot.Message) {
  await react(msg);
  const user = await findMemberByTelegram(msg.from?.username ?? "");
  if (!user) return bot.sendMessage(msg.chat.id, "Not registered. Contact an admin.");
  if (user.member_type === "day_pass") return bot.sendMessage(msg.chat.id, "Cold/hot desk members only. Use /daypass for a temporary code.");
  if (!user.pin_code) return bot.sendMessage(msg.chat.id, "No code set yet. Use /newcode to set one.");
  return bot.sendMessage(msg.chat.id, `Your door code is set. Tap below to reveal.`, {
    reply_markup: {
      inline_keyboard: [[{ text: "🔑 Reveal code", callback_data: `reveal_pin_${user.id}` }]],
    },
  });
}

async function handleNewCode(msg: TelegramBot.Message, match: RegExpExecArray | null) {
  await react(msg);
  const user = await findMemberByTelegram(msg.from?.username ?? "");
  if (!user) return bot.sendMessage(msg.chat.id, "Not registered. Contact an admin.");
  if (user.member_type === "day_pass") return bot.sendMessage(msg.chat.id, "Cold/hot desk members only.");
  if (!user.pin_code_slot) return bot.sendMessage(msg.chat.id, "No slot assigned. Contact an admin.");

  const arg = match?.[1]?.trim();

  if (arg) {
    const newCode = arg.toLowerCase() === "random"
      ? String(Math.floor(100000 + Math.random() * 900000))
      : /^\d{4,6}$/.test(arg) ? arg : null;

    if (!newCode) return bot.sendMessage(msg.chat.id, "Invalid code. Use 4-6 digits or 'random'.");

    try {
      const lockResults = await setUserCode(user.pin_code_slot, newCode);
      await db.from("members").update({ pin_code: newCode }).eq("id", user.id);
      const warning = formatLockWarning(lockResults);
      let reply = `Code updated!\n\n🔑 *${newCode}*`;
      if (warning) reply += `\n\n${warning}`;
      return bot.sendMessage(msg.chat.id, reply, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[NewCode] Failed to program lock:", err);
      return bot.sendMessage(msg.chat.id, "⚠️ Couldn't reach the door locks. This is usually temporary — try again in a moment.");
    }
  }

  pending.set(msg.chat.id, { type: "newcode", step: "awaiting_code", data: { userId: user.id, slot: user.pin_code_slot }, timestamp: Date.now() });
  return bot.sendMessage(msg.chat.id, "Send a 4-6 digit code, or 'random'. Type 'cancel' to abort.");
}

async function handleDayPass(msg: TelegramBot.Message) {
  await react(msg);
  const user = await findMemberByTelegram(msg.from?.username ?? "");
  if (!user) return bot.sendMessage(msg.chat.id, "Not registered. Contact an admin.");

  // Atomic decrement — prevents double-spend race condition
  const { data: newBalance, error: rpcError } = await db.rpc("decrement_day_pass_balance", {
    p_member_id: user.id,
    p_amount: 1,
  });

  if (rpcError || newBalance === -1) {
    return bot.sendMessage(msg.chat.id, "No day passes remaining. Contact an admin to top up.");
  }

  const slot = await findNextAvailableDayPassSlot();
  if (!slot) {
    // Refund the pass since we can't issue a code
    await db.rpc("increment_day_pass_balance", { p_member_id: user.id, p_amount: 1 });
    return bot.sendMessage(msg.chat.id, "All slots in use. Try again later or contact an admin.");
  }

  const code = generateRandomCode();
  const expiresAt = calculateDayPassExpiration();

  let lockResults;
  try {
    lockResults = await setUserCode(slot, code);
  } catch (err) {
    console.error("[DayPass] Failed to program lock:", err);
    // Refund the pass since we couldn't program the lock
    await db.rpc("increment_day_pass_balance", { p_member_id: user.id, p_amount: 1 });
    return bot.sendMessage(msg.chat.id, "⚠️ Couldn't reach the door locks. This is usually temporary — try again in a moment.");
  }

  await db.from("day_codes").insert({
    member_id: user.id,
    label: user.member_type === "day_pass" ? null : `Guest by ${user.name}`,
    code, pin_slot: slot, expires_at: expiresAt.toISOString(), is_active: true,
  });

  const remaining = newBalance as number;
  const warning = formatLockWarning(lockResults);
  let text = `${user.member_type === "day_pass" ? "Today's code" : "Guest code"}!\n\n🔑 *${code}*\n\nValid until: ${fmt(expiresAt)}\nPasses remaining: ${remaining}`;
  if (warning) text += `\n\n${warning}`;
  return bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
}

async function handleEmail(msg: TelegramBot.Message, match: RegExpExecArray | null) {
  await react(msg);
  const user = await findMemberByTelegram(msg.from?.username ?? "");
  if (!user) return bot.sendMessage(msg.chat.id, "Not registered. Contact an admin.");

  const email = match?.[1]?.trim();
  if (!email) {
    const current = user.email ? `Current email: ${user.email}\n\n` : "";
    return bot.sendMessage(msg.chat.id, `${current}Send your email:\n/email you@example.com`);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return bot.sendMessage(msg.chat.id, "Invalid email format. Try: /email you@example.com");
  }

  await db.from("members").update({ email }).eq("id", user.id);
  return bot.sendMessage(msg.chat.id, `Email updated to: ${email}`);
}

// ── Admin commands ──────────────────────────────────────────

async function handleQuickCode(msg: TelegramBot.Message, match: RegExpExecArray | null) {
  await react(msg);
  const admin = await findAdminByTelegram(msg.from?.username ?? "");
  if (!admin) return bot.sendMessage(msg.chat.id, "Admins only.");

  const label = match?.[1]?.trim() ?? null;
  pending.set(msg.chat.id, { type: "quickcode", step: "awaiting_expiration", data: { label }, timestamp: Date.now() });

  return bot.sendMessage(msg.chat.id, `Quick code${label ? ` for "${label}"` : ""}. Choose expiration:`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "6 PM", callback_data: "expire_6pm" }, { text: "9 PM", callback_data: "expire_9pm" }],
        [{ text: "Friday 9 PM", callback_data: "expire_friday" }, { text: "Custom", callback_data: "expire_custom" }],
      ],
    },
  });
}

async function handleCodes(msg: TelegramBot.Message) {
  await react(msg);
  const admin = await findAdminByTelegram(msg.from?.username ?? "");
  if (!admin) return bot.sendMessage(msg.chat.id, "Admins only.");
  return sendCodesList(msg.chat.id, 0);
}

async function sendCodesList(chatId: number, offset: number) {
  const { data: codes, count } = await db
    .from("day_codes")
    .select("*, members(name)", { count: "exact" })
    .eq("is_active", true)
    .order("expires_at", { ascending: true })
    .range(offset, offset + ITEMS_PER_PAGE - 1);

  if (!count) return bot.sendMessage(chatId, "No active codes.");

  let text = `Active Codes (${count}):\n\n`;
  const buttons = [];

  for (const [i, c] of (codes ?? []).entries()) {
    const member = c.members as { name: string } | null;
    const desc = c.label ?? member?.name ?? "(anonymous)";
    text += `${offset + i + 1}. ${c.code} — ${desc} — ${c.expires_at ? `expires ${fmt(new Date(c.expires_at))}` : "no expiry"}\n`;
    buttons.push([{ text: `Revoke ${c.code}`, callback_data: `revoke_${c.id}` }]);
  }

  const nav = [];
  if (offset > 0) nav.push({ text: "< Prev", callback_data: `page_codes_${offset - ITEMS_PER_PAGE}` });
  if (offset + ITEMS_PER_PAGE < (count ?? 0)) nav.push({ text: "Next >", callback_data: `page_codes_${offset + ITEMS_PER_PAGE}` });
  if (nav.length) buttons.push(nav);

  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: buttons } });
}

async function handleAdmin(msg: TelegramBot.Message) {
  await react(msg);
  const admin = await findAdminByTelegram(msg.from?.username ?? "");
  if (!admin) return bot.sendMessage(msg.chat.id, "Admins only.");

  pending.delete(msg.chat.id);

  return bot.sendMessage(msg.chat.id, "Admin Management:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Add Member", callback_data: "admin_addmember" }, { text: "Add Day Passes", callback_data: "admin_addpasses" }],
        [{ text: "Add Admin", callback_data: "admin_addadmin" }, { text: "Remove Admin", callback_data: "admin_removeadmin" }],
        [{ text: "List Members", callback_data: "admin_listmembers" }],
      ],
    },
  });
}

async function sendMembersList(chatId: number, offset: number) {
  const { data: members, count } = await db
    .from("members")
    .select("name, member_type, telegram_username, is_admin, day_passes_balance", { count: "exact" })
    .order("name")
    .range(offset, offset + ITEMS_PER_PAGE - 1);

  if (!count) return bot.sendMessage(chatId, "No members.");

  let text = `Members (${count}):\n\n`;
  (members ?? []).forEach((m, i) => {
    const type = m.member_type === "cold_desk" ? "🧊" : m.member_type === "hot_desk" ? "🔥" : m.member_type === "hub_friend" ? "🤝" : "🎫";
    text += `${offset + i + 1}. ${m.name} ${type} ${m.telegram_username ?? ""}${m.is_admin ? " [Admin]" : ""}`;
    if (m.member_type === "day_pass") text += ` (${m.day_passes_balance} passes)`;
    text += "\n";
  });

  const nav = [];
  if (offset > 0) nav.push({ text: "< Prev", callback_data: `page_members_${offset - ITEMS_PER_PAGE}` });
  if (offset + ITEMS_PER_PAGE < (count ?? 0)) nav.push({ text: "Next >", callback_data: `page_members_${offset + ITEMS_PER_PAGE}` });

  const opts = nav.length ? { reply_markup: { inline_keyboard: [nav] } } : {};
  return bot.sendMessage(chatId, text, opts);
}

// ── Callback queries ────────────────────────────────────────

async function handleCallback(query: TelegramBot.CallbackQuery) {
  const chatId = query.message!.chat.id;
  const data = query.data!;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  const username = query.from.username ?? "";

  // ── Member callbacks (no admin required) ──
  if (data.startsWith("reveal_pin_")) {
    const member = await findMemberByTelegram(username);
    if (!member) return bot.sendMessage(chatId, "Not registered.");
    const memberId = parseInt(data.replace("reveal_pin_", ""));
    if (member.id !== memberId) return; // Ignore if not the owner
    if (!member.pin_code) return bot.sendMessage(chatId, "No code set.");
    // Edit the original message to show the code, auto-hide after revealing
    return bot.editMessageText(`Your door code:\n\n🔑 *${member.pin_code}*`, {
      chat_id: chatId,
      message_id: query.message!.message_id,
      parse_mode: "Markdown",
    });
  }

  // ── Admin callbacks ──
  const admin = await findAdminByTelegram(username);
  if (!admin) return bot.sendMessage(chatId, "Admins only.");

  if (data.startsWith("expire_")) return handleExpirationCallback(chatId, data);
  if (data.startsWith("revoke_")) return handleRevokeCallback(chatId, parseInt(data.replace("revoke_", "")));
  if (data.startsWith("page_codes_")) return sendCodesList(chatId, parseInt(data.replace("page_codes_", "")));
  if (data.startsWith("page_members_")) return sendMembersList(chatId, parseInt(data.replace("page_members_", "")));
  if (data.startsWith("admin_")) return handleAdminMenu(chatId, data, admin);
  if (data.startsWith("membertype_")) return handleMemberType(chatId, data);
  if (data.startsWith("confirm_removeadmin_")) return handleRemoveAdmin(chatId, parseInt(data.replace("confirm_removeadmin_", "")));
}

async function handleExpirationCallback(chatId: number, data: string) {
  const p = pending.get(chatId);
  if (!p || p.type !== "quickcode") return;

  const preset = data.replace("expire_", "");
  if (preset === "custom") {
    p.step = "awaiting_custom_time";
    p.timestamp = Date.now();
    pending.set(chatId, p);
    return bot.sendMessage(chatId, "Enter expiration time (e.g. '8:30pm', '9pm'). Type 'cancel' to abort.");
  }

  const exp = calculateExpiration(preset);
  if (!exp) return bot.sendMessage(chatId, "Couldn't parse time.");
  pending.delete(chatId);
  return createQuickCode(chatId, exp, p.data.label as string | null);
}

async function createQuickCode(chatId: number, expiresAt: Date, label: string | null) {
  const slot = await findNextAvailableDayPassSlot();
  if (!slot) return bot.sendMessage(chatId, "All slots full. Use /codes to revoke unused ones.");

  const code = generateRandomCode();

  let lockResults;
  try {
    lockResults = await setUserCode(slot, code);
  } catch (err) {
    console.error("[QuickCode] Failed to program lock:", err);
    return bot.sendMessage(chatId, "⚠️ Couldn't reach the door locks. This is usually temporary — try again in a moment.");
  }

  await db.from("day_codes").insert({ label, code, pin_slot: slot, expires_at: expiresAt.toISOString(), is_active: true });

  const warning = formatLockWarning(lockResults);
  let text = `Quick code created!\n\n🔑 *${code}*\n\nExpires: ${fmt(expiresAt)}`;
  if (label) text += `\nLabel: ${label}`;
  if (warning) text += `\n\n${warning}`;
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

async function handleRevokeCallback(chatId: number, codeId: number) {
  const { data: code } = await db.from("day_codes").select("code, pin_slot, is_active").eq("id", codeId).single();
  if (!code || !code.is_active) return bot.sendMessage(chatId, "Code not found or already revoked.");

  await clearUserCode(code.pin_slot);
  await db.from("day_codes").update({ is_active: false, revoked_at: new Date().toISOString() }).eq("id", codeId);
  return bot.sendMessage(chatId, `Code ${code.code} revoked.`);
}

async function handleAdminMenu(chatId: number, data: string, admin: MemberRow) {
  pending.delete(chatId);

  switch (data) {
    case "admin_addmember":
      pending.set(chatId, { type: "addmember", step: "awaiting_type", data: {}, timestamp: Date.now() });
      return bot.sendMessage(chatId, "Coworking membership type?", {
        reply_markup: { inline_keyboard: [
          [{ text: "Cold Desk", callback_data: "membertype_cold_desk" }, { text: "Hot Desk", callback_data: "membertype_hot_desk" }],
          [{ text: "Hub Friend", callback_data: "membertype_hub_friend" }, { text: "Day Pass", callback_data: "membertype_day_pass" }],
        ]},
      });

    case "admin_addpasses":
      pending.set(chatId, { type: "addpasses", step: "awaiting_username", data: {}, timestamp: Date.now() });
      return bot.sendMessage(chatId, "Enter member's Telegram username (@username). Type 'cancel' to abort.");

    case "admin_addadmin":
      pending.set(chatId, { type: "addadmin", step: "awaiting_username", data: {}, timestamp: Date.now() });
      return bot.sendMessage(chatId, "Enter Telegram username of new admin. Type 'cancel' to abort.");

    case "admin_removeadmin": {
      const { data: admins } = await db.from("members").select("id, name, telegram_username").eq("is_admin", true);
      if ((admins?.length ?? 0) <= 1) return bot.sendMessage(chatId, "Cannot remove the last admin.");
      const buttons = (admins ?? []).map(a => ([{ text: `${a.name} (${a.telegram_username ?? "no tg"})`, callback_data: `confirm_removeadmin_${a.id}` }]));
      return bot.sendMessage(chatId, "Select admin to remove:", { reply_markup: { inline_keyboard: buttons } });
    }

    case "admin_listmembers":
      return sendMembersList(chatId, 0);
  }
}

async function handleMemberType(chatId: number, data: string) {
  const p = pending.get(chatId);
  if (!p || p.type !== "addmember") return;
  p.data.memberType = data.replace("membertype_", "");
  p.step = "awaiting_name";
  p.timestamp = Date.now();
  pending.set(chatId, p);
  return bot.sendMessage(chatId, "Enter the member's name. Type 'cancel' to abort.");
}

async function handleRemoveAdmin(chatId: number, userId: number) {
  const { count } = await db.from("members").select("*", { count: "exact", head: true }).eq("is_admin", true);
  if ((count ?? 0) <= 1) return bot.sendMessage(chatId, "Cannot remove the last admin.");

  const { data: user } = await db.from("members").select("name, telegram_username").eq("id", userId).single();
  if (!user) return bot.sendMessage(chatId, "User not found.");

  await db.from("members").update({ is_admin: false }).eq("id", userId);
  return bot.sendMessage(chatId, `${user.name} (${user.telegram_username ?? "no tg"}) is no longer an admin.`);
}

// ── Message handler for multi-step flows ───────────────────

async function handleMessage(msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text || text.startsWith("/")) return;

  const p = pending.get(chatId);
  if (!p) return;

  await react(msg);

  if (Date.now() - p.timestamp > 5 * 60 * 1000) {
    pending.delete(chatId);
    return bot.sendMessage(chatId, "Action timed out. Start again.");
  }

  if (text.toLowerCase() === "cancel") {
    pending.delete(chatId);
    return bot.sendMessage(chatId, "Cancelled.");
  }

  switch (p.type) {
    case "newcode": return handleNewCodeFlow(chatId, text, p);
    case "quickcode": return handleQuickCodeFlow(chatId, text, p);
    case "addmember": return handleAddMemberFlow(chatId, text, p);
    case "addpasses": return handleAddPassesFlow(chatId, text, p);
    case "addadmin": return handleAddAdminFlow(chatId, text);
  }
}

async function handleNewCodeFlow(chatId: number, text: string, p: PendingAction) {
  const code = text.toLowerCase() === "random"
    ? String(Math.floor(100000 + Math.random() * 900000))
    : /^\d{4,6}$/.test(text) ? text : null;

  if (!code) return bot.sendMessage(chatId, "Send 4-6 digits or 'random'. Type 'cancel' to abort.");

  try {
    const lockResults = await setUserCode(p.data.slot as number, code);
    await db.from("members").update({ pin_code: code }).eq("id", p.data.userId as number);
    pending.delete(chatId);
    const warning = formatLockWarning(lockResults);
    let reply = `Code updated!\n\n🔑 *${code}*`;
    if (warning) reply += `\n\n${warning}`;
    return bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[NewCode] Failed to program lock:", err);
    pending.delete(chatId);
    return bot.sendMessage(chatId, "⚠️ Couldn't reach the door locks. This is usually temporary — try again in a moment.");
  }
}

async function handleQuickCodeFlow(chatId: number, text: string, p: PendingAction) {
  if (p.step !== "awaiting_custom_time") return;
  const exp = calculateExpiration(text);
  if (!exp || exp <= new Date()) return bot.sendMessage(chatId, "Couldn't parse that time. Try '9pm' or '8:30pm'. Type 'cancel' to abort.");
  pending.delete(chatId);
  return createQuickCode(chatId, exp, p.data.label as string | null);
}

async function handleAddMemberFlow(chatId: number, text: string, p: PendingAction) {
  switch (p.step) {
    case "awaiting_name":
      p.data.name = text;
      p.step = "awaiting_telegram";
      p.timestamp = Date.now();
      pending.set(chatId, p);
      return bot.sendMessage(chatId, "Enter Telegram username (@username) or 'skip':");

    case "awaiting_telegram": {
      if (text.toLowerCase() !== "skip") {
        const tg = text.startsWith("@") ? text : `@${text}`;
        if (!/^@[a-zA-Z0-9_]{5,32}$/.test(tg)) return bot.sendMessage(chatId, "Invalid format. Try @username (5-32 chars) or 'skip':");
        p.data.telegram = tg;
      }
      if (p.data.memberType !== "day_pass") {
        p.step = "awaiting_pincode";
        p.timestamp = Date.now();
        pending.set(chatId, p);
        return bot.sendMessage(chatId, "Enter a 4-6 digit pin code, or 'random':");
      } else {
        p.step = "awaiting_passes";
        p.timestamp = Date.now();
        pending.set(chatId, p);
        return bot.sendMessage(chatId, "How many day passes? (default: 10):");
      }
    }

    case "awaiting_pincode": {
      const pin = text.toLowerCase() === "random" ? String(Math.floor(100000 + Math.random() * 900000)) : /^\d{4,6}$/.test(text) ? text : null;
      if (!pin) return bot.sendMessage(chatId, "Invalid. Enter 4-6 digits or 'random':");
      p.data.pinCode = pin;
      const slot = await findNextMemberSlot();
      if (!slot) {
        pending.delete(chatId);
        return bot.sendMessage(chatId, "All member slots (1–100) are full. Free up a slot or contact an admin.");
      }
      p.data.pinSlot = slot;
      pending.delete(chatId);
      return createMember(chatId, p.data);
    }

    case "awaiting_passes":
      p.data.passes = parseInt(text) || 10;
      pending.delete(chatId);
      return createMember(chatId, p.data);
  }
}

async function createMember(chatId: number, d: Record<string, unknown>) {
  const isFull = d.memberType !== "day_pass";
  let memberLockWarning: string | null = null;
  if (isFull && d.pinCode && d.pinSlot) {
    try {
      const lockResults = await setUserCode(d.pinSlot as number, d.pinCode as string);
      memberLockWarning = formatLockWarning(lockResults);
    } catch (err) {
      console.error("[CreateMember] Failed to program lock:", err);
      return bot.sendMessage(chatId, "⚠️ Couldn't reach the door locks. Member not created. This is usually temporary — try again in a moment.");
    }
  }

  const passCount = !isFull ? ((d.passes as number | undefined) ?? 10) : 0;

  const { data: member, error } = await db.from("members").insert({
    name: d.name as string,
    member_type: d.memberType as "cold_desk" | "hot_desk" | "hub_friend" | "day_pass",
    telegram_username: (d.telegram as string | undefined) ?? null,
    pin_code: isFull ? (d.pinCode as string) : null,
    pin_code_slot: isFull ? (d.pinSlot as number) : null,
    day_passes_balance: passCount,
  }).select().single();

  if (error) return bot.sendMessage(chatId, `Error: ${error.message}`);

  const typeLabel = d.memberType === "cold_desk" ? "Cold Desk" : d.memberType === "hot_desk" ? "Hot Desk" : d.memberType === "hub_friend" ? "Hub Friend" : "Day Pass";
  let text = `Member created!\n\nName: ${member.name}\nType: ${typeLabel}`;
  if (d.telegram) text += `\nTelegram: ${d.telegram}`;
  if (isFull) text += `\nSlot: ${d.pinSlot}\nCode: ${d.pinCode}`;
  else text += `\nDay Passes: ${d.passes ?? 10}`;
  if (memberLockWarning) text += `\n\n${memberLockWarning}`;

  return bot.sendMessage(chatId, text);
}

async function handleAddPassesFlow(chatId: number, text: string, p: PendingAction) {
  if (p.step === "awaiting_username") {
    const tg = text.startsWith("@") ? text : `@${text}`;
    const { data: member } = await db.from("members").select("id, name").eq("telegram_username", tg).single();
    if (!member) return bot.sendMessage(chatId, `${tg} not found. Try again or 'cancel':`);
    p.data.memberId = member.id;
    p.data.memberName = member.name;
    p.step = "awaiting_count";
    p.timestamp = Date.now();
    pending.set(chatId, p);
    return bot.sendMessage(chatId, `Found: ${member.name}\nHow many day passes to add?`);
  }

  if (p.step === "awaiting_count") {
    const count = parseInt(text);
    if (!count || count < 1) return bot.sendMessage(chatId, "Enter a number (1 or more):");
    // Atomic increment — prevents lost updates from concurrent admin operations
    const { data: newBalance, error } = await db.rpc("increment_day_pass_balance", {
      p_member_id: p.data.memberId as number,
      p_amount: count,
    });
    pending.delete(chatId);
    if (error || newBalance === -1) {
      return bot.sendMessage(chatId, "Failed to update balance. Member may have been deleted.");
    }
    return bot.sendMessage(chatId, `Added ${count} day pass${count > 1 ? "es" : ""} to ${p.data.memberName}. New balance: ${newBalance}`);
  }
}

async function handleAddAdminFlow(chatId: number, text: string) {
  const tg = text.startsWith("@") ? text : `@${text}`;
  const { data: member } = await db.from("members").select("id, name, is_admin").eq("telegram_username", tg).single();
  if (!member) return bot.sendMessage(chatId, `${tg} not found. They must be registered first. Try again or 'cancel':`);
  if (member.is_admin) { pending.delete(chatId); return bot.sendMessage(chatId, `${member.name} is already an admin.`); }

  await db.from("members").update({ is_admin: true }).eq("id", member.id);
  pending.delete(chatId);
  return bot.sendMessage(chatId, `${member.name} (${tg}) is now an admin.`);
}

// ── Start ───────────────────────────────────────────────────

export function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log("[Bot] No token — bot disabled."); return; }

  bot = new TelegramBot(token, { polling: true });
  console.log("[Bot] Started.");

  bot.onText(/\/start/, handleStart);
  bot.onText(/\/mycode/, handleMyCode);
  bot.onText(/\/newcode(?:\s+(.+))?/, handleNewCode);
  bot.onText(/\/daypass/, handleDayPass);
  bot.onText(/\/email(?:\s+(.+))?/, handleEmail);
  bot.onText(/\/help/, handleStart);
  bot.onText(/\/quickcode(?:\s+(.+))?/, handleQuickCode);
  bot.onText(/\/codes/, handleCodes);
  bot.onText(/\/admin/, handleAdmin);

  bot.on("callback_query", handleCallback);
  bot.on("message", handleMessage);
  bot.on("polling_error", (e) => console.error("[Bot] Polling error:", e.message));
}
