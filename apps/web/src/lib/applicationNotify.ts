/**
 * Telegram "New Application" notification to the RegenHub group. Shared by the
 * application submission path so the member coordinator always gets pinged —
 * regardless of which route saved the application.
 */

const interestLabels: Record<string, string> = {
  daypass_single: "Day Pass",
  member_basic: "Member + 1 day/mo ($30/mo)",
  member_2day: "Member + 2 days/mo ($50/mo)",
  member_5day: "Member + 5 days/mo ($100/mo)",
  // Legacy keys kept for historical applications
  daypass_5pack: "5-Pack Day Passes (legacy)",
  social_events_1: "Social — 1 day/mo (legacy)",
  social_events_5: "Social — 5 days/mo (legacy)",
  hot_desk: "Full Access — Hot Desk",
  reserved_desk: "Full Access — Cold Desk",
  community: "Community",
};

export interface ApplicationNotice {
  /** applications.id — enables the inline Approve button; omit to send link-only. */
  id?: number;
  name: string;
  email: string;
  telegram?: string | null;
  about?: string | null;
  why_join?: string | null;
  membership_interest: string;
}

/**
 * Post a "New Application" notification to the RegenHub Telegram group.
 * Fire-and-forget. Mirrors the free-day notification's approve-from-chat UX:
 * the ✅ button (handled by the bot, `app_approve_<id>`) approves at the
 * standard rate for their requested tier and emails them the next step;
 * custom pricing/discounts still go through the admin panel.
 */
export async function notifyNewApplication(app: ApplicationNotice): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;

  const lines = [
    `📋 *New Application*`,
    ``,
    `*${app.name}*  ·  ${app.email}`,
    `Interest: ${interestLabels[app.membership_interest] ?? app.membership_interest}`,
  ];
  if (app.telegram) lines.push(`Telegram: @${app.telegram.replace(/_/g, "\\_")}`);
  if (app.about) lines.push(``, `_Working on:_ ${app.about}`);
  if (app.why_join) lines.push(``, `_Why join:_ ${app.why_join}`);

  const reply_markup = app.id
    ? {
        inline_keyboard: [
          [
            { text: "✅ Approve (standard rate)", callback_data: `app_approve_${app.id}` },
            { text: "Custom pricing →", url: "https://regenhub.xyz/admin/applications" },
          ],
        ],
      }
    : undefined;
  if (!app.id) lines.push(``, `[Review →](https://regenhub.xyz/admin/applications)`);

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        ...(reply_markup ? { reply_markup } : {}),
      }),
    });
  } catch (err) {
    console.error("[Application] Telegram notify error:", err);
  }
}
