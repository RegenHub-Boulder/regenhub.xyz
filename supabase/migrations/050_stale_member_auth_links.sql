-- Migration 050: find and repair stale members.supabase_user_id links
--
-- Incident: a member (omniharmonic) lost access to his old email, signed up
-- fresh with a new one, and an admin deleted that new account via the portal
-- "delete member" flow. That flow only ever deletes the `members` row —
-- migration 004/013's auto-link triggers are one-directional (they populate
-- supabase_user_id when it's NULL), and nothing in this codebase deletes the
-- underlying `auth.users` row, so it stuck around orphaned. The admin then
-- moved the new email onto the member's original (correct, DID-bearing) row.
-- That row's supabase_user_id kept pointing at the OLD, now-orphaned
-- auth.users id, while a NEW auth.users row was silently created for the new
-- email the moment he signed up. Trigger 013 only relinks when
-- supabase_user_id IS NULL, so it never fired — his real member row became
-- unreachable via sign-in, and he landed on the "application approved, admin
-- needs to set something up" screen instead of his account. Fixed by hand via
-- direct SQL once; this migration makes that repeatable without DB surgery.
--
-- Both functions live in `public`, not `auth`, because PostgREST never
-- exposes the `auth` schema over the REST API — not even to the service
-- role. That's the same reason 004/013's triggers, and 046's
-- bind_member_wallet, all read/write auth.users from `public`-schema
-- SECURITY DEFINER functions rather than querying `auth.*` directly from a
-- route. These two are read-only diagnostics/lookups (no writes to
-- auth.users), called from admin API routes via the service-role client's
-- .rpc(), so — same as 046 — they're locked to service_role only.
--
-- find_stale_member_links: the general shape of the bug above — any member
-- whose supabase_user_id points at an auth.users row that no longer exists.
-- Surfaced in an admin UI so this doesn't require someone to notice a support
-- ticket and reach for psql.
--
-- current_auth_user_for_email: given a member's email, what auth.users row
-- would sign-in currently resolve to. Used both by the relink action (find
-- the live identity to point supabase_user_id at) and by the delete-member
-- guardrail (warn an admin who deletes a member row that the email can still
-- sign in via a live auth.users row that will now be orphaned).

create or replace function public.find_stale_member_links()
returns table (
  member_id integer,
  email text,
  name text,
  supabase_user_id uuid,
  has_did boolean
)
language sql
security definer
set search_path = public
as $$
  select m.id, m.email, m.name, m.supabase_user_id, (m.did is not null)
  from members m
  where m.supabase_user_id is not null
    and not exists (
      select 1 from auth.users u where u.id = m.supabase_user_id
    );
$$;

create or replace function public.current_auth_user_for_email(target_email text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select u.id
  from auth.users u
  where lower(u.email) = lower(target_email)
  order by u.created_at desc
  limit 1;
$$;

revoke all on function public.find_stale_member_links() from public, anon, authenticated;
grant execute on function public.find_stale_member_links() to service_role;

revoke all on function public.current_auth_user_for_email(text) from public, anon, authenticated;
grant execute on function public.current_auth_user_for_email(text) to service_role;
