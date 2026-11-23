import { createServiceClient } from "@/lib/supabase/admin";

/**
 * The record of emails sent one person at a time (migration 069, T-482 round 3): the one send function
 * (lib/email.ts `sendEmailDetailed`) writes a row per send; the admin member page reads them. Metadata only: who,
 * what kind, the subject, the provider's message id, the outcome. Never the body (it can hold sign-in links and
 * door codes).
 *
 * Works before 069 runs: a missing table is skipped on write (the send still goes) and the page says so.
 */

export const EMAIL_LOG_MIGRATION = "069_email_log.sql";

/** Every kind of email the web app sends, with how the member page names it. A new sender adds its kind here. */
export const EMAIL_KINDS = {
  application_received: "Application received",
  approval_checkout: "Approved: checkout link",
  membership_approved: "Approved for membership",
  free_day_approved: "Free day approved",
  welcome: "Welcome",
  payment_failed: "Payment failed",
  payment_reminder: "Payment reminder",
  subscription_ended: "Membership ended",
  onchain_renewal_reminder: "USDC renewal reminder",
  day_pass_receipt: "Day pass receipt",
  monthly_passes: "Monthly day passes",
  nudge_never_visited: "Nudge: haven't visited yet",
  nudge_come_back: "Nudge: come back",
  nudge_balance_empty: "Nudge: passes used up",
  group_message: "Message to a group",
  night_followup: "Note after a night",
  techne_link: "Techne link request",
  techne_linked: "Techne account linked",
  admin_digest: "Admin digest",
  hub_digest: "Hub digest",
  newsletter_preview: "Newsletter preview",
  /** Not logged: each issue's sends are in newsletter_sends. */
  newsletter: "Newsletter",
} as const;
export type EmailKind = keyof typeof EMAIL_KINDS;

export const emailKindLabel = (kind: string): string => (EMAIL_KINDS as Record<string, string>)[kind] ?? kind;

export interface EmailLogEntry {
  member_id?: number | null;
  email: string;
  kind: EmailKind;
  subject: string;
  provider: string;
  provider_id?: string | null;
  status: "sent" | "failed";
  error?: string | null;
}

/** PostgREST / Postgres for "that table doesn't exist" (the migration hasn't run). */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205"
    || /relation .*email_log.* does not exist|could not find the table .*email_log/i.test(error.message ?? "");
}

const LOG_TIMEOUT_MS = 2000;

type Client = Pick<ReturnType<typeof createServiceClient>, "from">;

/**
 * Write one row. Never throws and never blocks the send's result: "logged", "no_table" (069 hasn't run) or "failed".
 * Only the fields named here are written, so a caller can't put a body or link in the log.
 */
export async function recordEmail(entry: EmailLogEntry, client?: Client): Promise<"logged" | "no_table" | "failed" | "skipped"> {
  if (entry.kind === "newsletter") return "skipped";
  try {
    const db = client ?? createServiceClient();
    // Bounded: the mail has already gone, so a slow database must not hold up the sender (night follow-ups, bulk
    // group messages). Past the limit the row is given up, as with any failed write.
    const insert = db.from("email_log").insert({
      member_id: entry.member_id ?? null,
      email: entry.email.trim().toLowerCase(),
      kind: entry.kind,
      subject: entry.subject.slice(0, 300),
      provider: entry.provider,
      provider_id: entry.provider_id ?? null,
      status: entry.status,
      error: entry.error ? entry.error.replace(/\s+/g, " ").slice(0, 200) : null,
    });
    const timedOut = new Promise<{ error: { message: string } }>((resolve) => {
      const t = setTimeout(() => resolve({ error: { message: `timed out after ${LOG_TIMEOUT_MS} ms` } }), LOG_TIMEOUT_MS);
      (t as { unref?: () => void }).unref?.();
    });
    const { error } = await Promise.race([Promise.resolve(insert), timedOut]) as { error: { code?: string; message?: string } | null };
    if (!error) return "logged";
    if (isMissingTable(error)) return "no_table";
    console.error("[email log] write failed:", error.message ?? error);
    return "failed";
  } catch (err) {
    console.error("[email log] write failed:", err instanceof Error ? err.message : err);
    return "failed";
  }
}

export interface EmailLogRow {
  id: number;
  kind: string;
  subject: string;
  status: "sent" | "failed";
  error: string | null;
  provider: string;
  provider_id: string | null;
  sent_at: string;
}

export type EmailHistory =
  | { state: "ok"; rows: EmailLogRow[] }
  | { state: "no_table" }
  | { state: "error" };

const COLUMNS = "id, kind, subject, status, error, provider, provider_id, sent_at";

/** A member's emails, newest first: rows with their member id, plus rows sent to their email before it was known. */
export async function readEmailHistory(client: Client, member: { id: number; email: string | null }, limit = 30): Promise<EmailHistory> {
  const byId = client.from("email_log").select(COLUMNS).eq("member_id", member.id).order("sent_at", { ascending: false }).limit(limit);
  const byEmail = member.email
    ? client.from("email_log").select(COLUMNS).eq("email", member.email.trim().toLowerCase()).order("sent_at", { ascending: false }).limit(limit)
    : null;
  const [a, b] = await Promise.all([byId, byEmail ?? Promise.resolve({ data: [], error: null })]);
  for (const r of [a, b]) {
    if (isMissingTable(r.error)) return { state: "no_table" };
    if (r.error) {
      console.error("[email log] read failed:", r.error.message);
      return { state: "error" };
    }
  }
  const seen = new Map<number, EmailLogRow>();
  for (const row of [...((a.data ?? []) as EmailLogRow[]), ...((b.data ?? []) as EmailLogRow[])]) seen.set(row.id, row);
  return { state: "ok", rows: [...seen.values()].sort((x, y) => y.sent_at.localeCompare(x.sent_at)).slice(0, limit) };
}
