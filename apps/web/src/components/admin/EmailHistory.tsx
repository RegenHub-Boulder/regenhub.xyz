import { EMAIL_LOG_MIGRATION, emailKindLabel, type EmailHistory as History } from "@/lib/emailLog";
import { fmtBoulderDateTime } from "@/lib/boulderTime";

/**
 * The emails a member got, newest first (email_log, migration 069), on the admin member page's Activity tab.
 * Metadata only: when, what kind, the subject, and whether it went. Newsletter issues aren't listed (see Mail).
 */
export function EmailHistory({ history }: { history: History }) {
  const migration = EMAIL_LOG_MIGRATION.replace(/_.*$/, "");
  return (
    <section aria-labelledby="emails" className="space-y-2" data-testid="email-history">
      <h3 id="emails" className="font-semibold">Emails</h3>
      {history.state === "no_table" ? (
        <p className="text-sm text-muted">Email history starts once migration {migration} runs.</p>
      ) : history.state === "error" ? (
        <p className="text-sm text-danger">Couldn&apos;t read the email history just now. Reload in a minute.</p>
      ) : history.rows.length === 0 ? (
        <p className="text-sm text-muted">No emails to this member since the log started. Newsletters are on Mail.</p>
      ) : (
        <ul className="divide-y divide-rule border-y border-rule">
          {history.rows.map((r) => (
            <li key={r.id} className="py-2.5 flex flex-col sm:flex-row sm:items-baseline gap-x-4 gap-y-0.5 text-sm">
              <span className="w-28 shrink-0 text-xs text-muted tabular-nums">{fmtBoulderDateTime(r.sent_at)}</span>
              <span className="flex-1 min-w-0">
                {emailKindLabel(r.kind)}
                <span className="text-muted"> · {r.subject}</span>
              </span>
              {r.status === "failed" ? (
                <span className="text-xs text-danger" title={r.error ?? undefined}>Didn&apos;t send{r.error ? `: ${r.error}` : ""}</span>
              ) : (
                <span className="text-xs text-muted">Sent</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
