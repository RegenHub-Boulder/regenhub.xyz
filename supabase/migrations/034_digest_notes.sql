-- Migration 034: Digest notes — the human voice in the monthly hub-health digest
--
-- The monthly digest (Bet 2: radical transparency lite) auto-compiles stats,
-- but the thing that makes it feel like a cooperative rather than a SaaS
-- report is one human note from the member coordinator. Admins write the
-- note any time during the month via /admin/communications; when the digest
-- cron fires on the 1st it picks the latest unconsumed note, includes it,
-- and marks it consumed.
--
-- If no note is waiting, the digest sends with stats only.

create table digest_notes (
  id                serial primary key,
  note              text not null,
  author_member_id  integer references members(id) on delete set null,
  created_at        timestamptz not null default now(),
  consumed_at       timestamptz             -- set when a digest includes it
);

create index digest_notes_unconsumed_idx on digest_notes (created_at desc)
  where consumed_at is null;

alter table digest_notes enable row level security;

create policy "admins_all_digest_notes" on digest_notes
  for all using (
    exists (
      select 1 from members
       where supabase_user_id = auth.uid()
         and is_admin = true
    )
  );
