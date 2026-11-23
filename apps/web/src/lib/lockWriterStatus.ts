import { LOCK_WRITER_LEASE_SECONDS } from "@regenhub/shared";

/**
 * The door-code writer in plain words (T-482), for Door → Lock Sync and the admin home. Pure, so the copy is tested
 * from rows. The writer is one row (`lock_slot_writer`): whoever holds it is changing door codes right now. Since
 * migration 070 a live holder renews `renewed_at` every 20 s; a row older than the lease is a writer that stopped
 * (a deploy or crash mid-change), and the next door-code change takes it over. Before 070 there's no `renewed_at`
 * and nothing takes over, so the page says what an operator has to do instead.
 */
export interface LockWriterRow {
  holder_label?: string | null;
  acquired_at: string;
  /** Present once migration 070 has run. */
  renewed_at?: string | null;
}

export interface LockWriterStatus {
  state: "running" | "stuck";
  holder: string;
  /** ISO time it took the writer. */
  since: string;
  /** One or two sentences for the page. */
  text: string;
}

export function lockWriterStatus(row: LockWriterRow | null, nowMs: number, fmt: (iso: string) => string): LockWriterStatus | null {
  if (!row) return null;
  const holder = row.holder_label?.trim() || "a door-code writer";
  const hasLease = row.renewed_at !== undefined && row.renewed_at !== null;
  const lastSign = Date.parse(hasLease ? row.renewed_at! : row.acquired_at);
  const stuck = nowMs - lastSign > LOCK_WRITER_LEASE_SECONDS * 1000;
  if (!stuck) {
    return { state: "running", holder, since: row.acquired_at,
      text: `A door-code change is running (${holder}, since ${fmt(row.acquired_at)}).` };
  }
  return {
    state: "stuck", holder, since: row.acquired_at,
    text: hasLease
      ? `The door-code writer stopped part-way: ${holder} took it at ${fmt(row.acquired_at)} and hasn't been heard from since ${fmt(row.renewed_at!)}. ` +
        "The next door-code change takes it over; any slot it was changing stays in quarantine until cleared."
      : `The door-code writer has been held by ${holder} since ${fmt(row.acquired_at)}. ` +
        "Until migration 070 runs it doesn't free itself: see “Door-code writer lease” in DEPLOYMENT.md.",
  };
}

/** An admin_actions row of action `lock_writer_failed` (migration 070's record_lock_writer_failure). */
export interface LockWriteFailureRow {
  created_at: string;
  payload: { holder?: string; error?: string; busy?: boolean; held_by?: string | null; held_since?: string | null } | null;
}

/** One line per failed door-code change, newest first: when, who tried, and why in plain words. */
export function recentLockWriteFailures(rows: LockWriteFailureRow[], fmt: (iso: string) => string): { key: string; line: string }[] {
  return rows.map((r, i) => {
    const p = r.payload ?? {};
    const who = p.holder || "A door-code writer";
    const why = p.busy
      ? `couldn't start: the writer was held${p.held_by ? ` by ${p.held_by}` : ""}${p.held_since ? ` since ${fmt(p.held_since)}` : ""}`
      : `stopped part-way${p.error ? ` (${p.error.replace(/\s+/g, " ").slice(0, 120)})` : ""}`;
    return { key: `${r.created_at}-${i}`, line: `${fmt(r.created_at)}: ${who} ${why}.` };
  });
}

type WriterRead = { data: unknown; error: { code?: string; message: string } | null };
type WriterQuery = { select(columns: string): { eq(column: string, value: number): { maybeSingle(): PromiseLike<WriterRead> } } };

/**
 * Read the writer row without its token (the token is the write credential; it never leaves the database here).
 * Before migration 070 there's no `renewed_at`, so a missing column falls back to the 054 columns.
 */
export async function readLockWriter(client: { from(table: string): unknown }): Promise<{ data: LockWriterRow | null; error: WriterRead["error"] }> {
  const read = (columns: string) => (client.from("lock_slot_writer") as WriterQuery).select(columns).eq("id", 1).maybeSingle();
  const first = await read("acquired_at, holder_label, renewed_at");
  if (first.error && (first.error.code === "42703" || /renewed_at/.test(first.error.message))) {
    const old = await read("acquired_at, holder_label");
    return { data: old.data as LockWriterRow | null, error: old.error };
  }
  return { data: first.data as LockWriterRow | null, error: first.error };
}
