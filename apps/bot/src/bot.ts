import TelegramBot from "node-telegram-bot-api";
import { db, findMemberByTelegram, findAdminByTelegram, type MemberRow } from "./db/supabase.js";
import { setUserCode, clearUserCode } from "./helpers/homeAssistant.js";
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

  const isFull = user.member_type === "full";
  let text = `Welcome back, ${user.name}!\n\n`;
  text += isFull
    ? `/mycode — Your door code\n/newcode — Change your code\n/daypass — Guest code\n/help — Help`
    : `/daypass — Get today's code\n/help — Help`;

  if (user.is_admin) text += `\n\nAdmin:\n/quickcode — Quick code\n/codes — Active codes\n/admin — Manage members`;
  return bot.sendMessage(msg.chat.id, text);
}

async function handleMyCode(msg: TelegramBot.Message) {
  await react(msg);
  const user = await findMemberByTelegram(msg.from?.username ?? "");
  if (!user) return bot.sendMessage(msg.chat.id, "Not registered. Contact an admin.");
  if (user.member_type !== "full") return bot.sendMessage(msg.chat.id, "Full members only. Use /daypass for a temporary code.");
  if (!user.pin_code) return bot.sendMessage(msg.chat.id, "No code set yet. Use /newcode to set one.");
  return bot.sendMessage(msg.chat.id, `Your door code:\n\n🔑 *${user.pin_code}*\n\nSlot: ${user.pin_code_slot}`, { parse_mode: "Markdown" });
}

async function handleNewCode(msg: TelegramBot.Message, match: RegExpExecArray | null) {
  await react(msg);
  const user = await findMemberByTelegram(msg.from?.username ?? "");
  if (!user) return bot.sendMessage(msg.chat.id, "Not registered. Contact an admin.");
  if (user.member_type !== "full") return bot.sendMessage(msg.chat.id, "Full members only.");
  if (!user.pin_code_slot) return bot.sendMessage(msg.chat.id, "No slot assigned. Contact an admin.");

  const arg = match?.[1]?.trim();

  if (arg) {
    const newCode = arg.toLowerCase() === "random"
      ? String(Math.floor(100000 + Math.random() * 900000))
      : /^\d{4,6}$/.test(arg) ? arg : null;

    if (!newCode) return bot.sendMessage(msg.chat.id, "Invalid code. Use 4-6 digits or 'random'.");

    try {
      await setUserCode(user.pin_code_slot, newCode);
      await db.from("members").update({ pin_code: newCode }).eq("id", user.id);
      return bot.sendMessage(msg.chat.id, `Code updated!\n\n🔑 *${newCode}*`, { parse_mode: "Markdown" });
    } catch {
      return bot.sendMessage(msg.chat.id, "Error updating code. Try again.");
    }
  }

  pending.set(msg.chat.id, { type: "newcode", step: "awaiting_code", data: { userId: user.id, slot: user.pin_code_slot }, timestamp: Date.now() });
  return bot.sendMessage(msg.chat.id, "Send a 4-6 digit code, or 'random'. Type 'cancel' to abort.");
}

async function handleDayPass(msg: TelegramBot.Message) {
  await react(msg);
  const user = await findMemberByTelegram(msg.from?.username ?? "");
  if (!user) return bot.sendMessage(msg.chat.id, "Not registered. Contact an admin.");

  const slot = await findNextAvailableDayPassSlot();
  if (!slot) return bot.sendMessage(msg.chat.id, "All slots in use. Try again later or contact an admin.");

  if (user.member_type !== "full") {
    // Day pass member: check existing active code first
    const { data: existing } = await db
      .from("day_codes")
      .select("code, expires_at")
      .eq("member_id", user.id)
      .eq("is_active", true)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (existing) {
      return bot.sendMessage(msg.chat.id,
        `You already have an active code!\n\n🔑 *${existing.code}*\n\nValid until: ${fmt(new Date(existing.expires_at))}`,
        { parse_mode: "Markdown" }
      );
    }

    // Find valid day pass
    const { data: dayPass } = await db
      .from("day_passes")
      .select("*")
      .eq("member_id", user.id)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order("expires_at", { ascending: true })
      .limit(1)
      .single();

    if (!dayPass || dayPass.used_count >= dayPass.allowed_uses) {
      return bot.sendMessage(msg.chat.id, "No day passes remaining. Contact an admin to purchase more.");
    }

    const code = generateRandomCode();
    const expiresAt = calculateDayPassExpiration();

    await setUserCode(slot, code);
    await db.from("day_codes").insert({
      day_pass_id: dayPass.id, member_id: user.id,
      code, pin_slot: slot, expires_at: expiresAt.toISOString(), is_active: true,
    });
    await db.from("day_passes").update({ used_count: dayPass.used_count + 1 }).eq("id", dayPass.id);

    const remaining = dayPass.allowed_uses - dayPass.used_count - 1;
    return bot.sendMessage(msg.chat.id,
      `Today's code!\n\n🔑 *${code}*\n\nValid until: ${fmt(expiresAt)}\nPasses remaining: ${remaining}`,
      { parse_mode: "Markdown" }
    );
  }

  // Full member guest code
  const code = generateRandomCode();
  const expiresAt = calculateDayPassExpiration();

  await setUserCode(slot, code);
  await db.from("day_codes").insert({
    member_id: user.id, label: `Guest by ${user.name}`,
    code, pin_slot: slot, expires_at: expiresAt.toISOString(), is_active: true,
  });

  return bot.sendMessage(msg.chat.id,
    `Guest code!\n\n🔑 *${code}*\n\nValid until: ${fmt(expiresAt)}\nShare with your guest.`,
    { parse_mode: "Markdown" }
  );
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
        [{ text: "6 PM", callback_data: "expire_6pm" }, { text: "9 PM", callback_data: "expire_9pm" }, { text: "3 AM", callback_data: "expire_3am" }],
        [{ text: "Custom", callback_data: "expire_custom" }],
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
    text += `${offset + i + 1}. ${c.code} — ${desc} — expires ${fmt(new Date(c.expires_at))}\n`;
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

// ── Callback queries ────────────────────────────────────────

async function handleCallback(query: TelegramBot.CallbackQuery) {
  const chatId = query.message!.chat.id;
  const data = query.data!;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  const username = query.from.username ?? "";
  const admin = await findAdminByTelegram(username);
  if (!admin) return bot.sendMessage(chatId, "Admins only.");

  if (data.startsWith("expire_")) return handleExpirationCallback(chatId, data);
  if (data.startsWith("revoke_")) return handleRevokeCallback(chatId, parseInt(data.replace("revoke_", "")));
  if (data.startsWith("page_codes_")) return sendCodesList(chatId, parseInt(data.replace("page_codes_", "")));
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
  await setUserCode(slot, code);
  await db.from("day_codes").insert({ label, code, pin_slot: slot, expires_at: expiresAt.toISOString(), is_active: true });

  let text = `Quick code created!\n\n🔑 *${code}*\n\nExpires: ${fmt(expiresAt)}`;
  if (label) text += `\nLabel: ${label}`;
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
      return bot.sendMessage(chatId, "Member type?", {
        reply_markup: { inline_keyboard: [[{ text: "Full Member", callback_data: "membertype_full" }, { text: "Day Pass", callback_data: "membertype_daypass" }]] },
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

    case "admin_listmembers": {
      const { data: members, count } = await db.from("members").select("name, member_type, telegram_username, is_admin", { count: "exact" }).order("name").range(0, ITEMS_PER_PAGE - 1);
      let text = `Members (${count ?? 0}):\n\n`;
      (members ?? []).forEach((m, i) => {
        text += `${i + 1}. ${m.name} — ${m.member_type} ${m.telegram_username ?? ""}${m.is_admin ? " [Admin]" : ""}\n`;
      });
      return bot.sendMessage(chatId, text);
    }
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

  await setUserCode(p.data.slot as number, code);
  await db.from("members").update({ pin_code: code }).eq("id", p.data.userId as number);
  pending.delete(chatId);
  return bot.sendMessage(chatId, `Code updated!\n\n🔑 *${code}*`, { parse_mode: "Markdown" });
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
      p.step = p.data.memberType === "full" ? "awaiting_telegram" : "awaiting_telegram";
      p.timestamp = Date.now();
      pending.set(chatId, p);
      return bot.sendMessage(chatId, "Enter Telegram username (@username) or 'skip':");

    case "awaiting_telegram": {
      if (text.toLowerCase() !== "skip") {
        const tg = text.startsWith("@") ? text : `@${text}`;
        if (!/^@[a-zA-Z0-9_]{5,32}$/.test(tg)) return bot.sendMessage(chatId, "Invalid format. Try @username (5-32 chars) or 'skip':");
        p.data.telegram = tg;
      }
      if (p.data.memberType === "full") {
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
      p.data.pinSlot = await findNextMemberSlot();
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
  const isFull = d.memberType === "full";
  if (isFull && d.pinCode && d.pinSlot) await setUserCode(d.pinSlot as number, d.pinCode as string);

  const { data: member, error } = await db.from("members").insert({
    name: d.name as string,
    member_type: d.memberType as "full" | "daypass",
    telegram_username: (d.telegram as string | undefined) ?? null,
    pin_code: isFull ? (d.pinCode as string) : null,
    pin_code_slot: isFull ? (d.pinSlot as number) : null,
    membership_tier: "coworking",
  }).select().single();

  if (error) return bot.sendMessage(chatId, `Error: ${error.message}`);

  if (!isFull && d.passes) {
    await db.from("day_passes").insert({ member_id: member.id, allowed_uses: d.passes as number });
  }

  let text = `Member created!\n\nName: ${member.name}\nType: ${isFull ? "Full" : "Day Pass"}`;
  if (d.telegram) text += `\nTelegram: ${d.telegram}`;
  if (isFull) text += `\nSlot: ${d.pinSlot}\nCode: ${d.pinCode}`;
  else text += `\nDay Passes: ${d.passes ?? 10}`;

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
    await db.from("day_passes").insert({ member_id: p.data.memberId as number, allowed_uses: count });
    pending.delete(chatId);
    return bot.sendMessage(chatId, `Added ${count} day pass${count > 1 ? "es" : ""} to ${p.data.memberName}.`);
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
  bot.onText(/\/help/, handleStart);
  bot.onText(/\/quickcode(?:\s+(.+))?/, handleQuickCode);
  bot.onText(/\/codes/, handleCodes);
  bot.onText(/\/admin/, handleAdmin);

  bot.on("callback_query", handleCallback);
  bot.on("message", handleMessage);
  bot.on("polling_error", (e) => console.error("[Bot] Polling error:", e.message));
}
