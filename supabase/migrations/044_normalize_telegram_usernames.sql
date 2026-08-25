-- Migration 044: one canonical form for members.telegram_username — bare, no "@".
--
-- The column drifted into two shapes. The write paths that matter already agree
-- on bare: application approval (api/admin/applications/[id]/approve) and the
-- member profile route both `.replace(/^@+/, "")` before storing, and every
-- display site adds the "@" back for presentation (lifecycle-nudges, freeday,
-- the MCP audit). But two admin routes stored whatever they were handed, so ~37
-- rows accumulated a leading "@". The Telegram API never sends "@", so bare is
-- the true canonical form; the "@"-prefixed rows are the anomaly.
--
-- That drift is what silently broke the bot's /quickcode gate for the bare
-- rows before the matcher was taught to ignore "@" (PR #65). With the matcher
-- now tolerant of both, this migration removes the ambiguity at the source:
-- strip any leading "@", trim, and null out anything left empty. Idempotent —
-- the WHERE clause only touches rows that actually change.

update members
set telegram_username = nullif(btrim(regexp_replace(telegram_username, '^@+', '')), '')
where telegram_username is not null
  and telegram_username is distinct from nullif(btrim(regexp_replace(telegram_username, '^@+', '')), '');
