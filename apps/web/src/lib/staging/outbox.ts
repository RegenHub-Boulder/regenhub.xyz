import { isEmailConfigured } from "@/lib/email";
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
  const box = (g.__regenhubStagingOutbox ??= []);
  box.unshift({ to, subject: mail.subject, html: mail.html, at: new Date().toISOString() });
  box.length = Math.min(box.length, 10);
}

export function stagingOutboxMails(): Mail[] {
  return isStandInEnabled() ? (g.__regenhubStagingOutbox ?? []) : [];
}
