import { isEmailConfigured, type EmailProvider } from "@/lib/email";
import { isStandInEnabled } from "@/lib/techne/config";

/**
 * STAGING ONLY: the last few emails the app would have sent, when it runs with the Techne stand-in and no
 * email provider, so the preview can show "the email the member gets" (GET /staging/outbox). Never on for
 * regenhub.xyz (isStandInEnabled), and never when email is configured.
 */
type Mail = { to: string; subject: string; html: string; at: string };
const g = globalThis as { __regenhubStagingOutbox?: Mail[] };

export function stagingOutbox(to: string, mail: { subject: string; html: string }): void {
  if (!isStandInEnabled() || isEmailConfigured()) return;
  keep(to, mail);
}

function keep(to: string, mail: { subject: string; html: string }): void {
  const box = (g.__regenhubStagingOutbox ??= []);
  box.unshift({ to, subject: mail.subject, html: mail.html, at: new Date().toISOString() });
  box.length = Math.min(box.length, 10);
}

export function stagingOutboxMails(): Mail[] {
  return isStandInEnabled() ? (g.__regenhubStagingOutbox ?? []) : [];
}

/**
 * STAGING ONLY: the outbox as an email provider (lib/email.ts, EMAIL_PROVIDER=outbox), so a send on the preview runs
 * the whole path through the one send function and lands here instead of in anyone's inbox. Configured only with the
 * Techne stand-in on, so it can never stand in for real mail on regenhub.xyz.
 */
export const outboxProvider: EmailProvider = {
  name: "outbox",
  configured: () => isStandInEnabled(),
  async send(mail) {
    if (!isStandInEnabled()) return { ok: false, rateLimited: false, quotaExceeded: false, error: "outbox is staging only" };
    keep(mail.to, mail);
    return { ok: true, rateLimited: false, quotaExceeded: false, id: `outbox-${Date.now()}` };
  },
};
