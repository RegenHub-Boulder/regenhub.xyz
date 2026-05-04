-- Migration 020: link interests to members
--
-- The /interest form (migration 019) captures email-only signups that today
-- live in their own silo. This migration connects those rows to the rest of
-- the funnel: when a person who once submitted interest becomes a member,
-- we know who they are.
--
-- Three layers ensure linkage works regardless of event order:
--
--   (a) Backfill at migration time — existing interests linked to existing
--       members by case-insensitive email match.
--   (b) Auth-side trigger (extending migration 004 — link_member_on_auth) —
--       when an auth.users row appears, we link members.supabase_user_id and
--       *also* fill in any matching interests.member_id.
--   (c) API route (apps/web/src/app/api/interest/route.ts) — looks up
--       members by email on POST and sets member_id directly when a match
--       exists at signup time.
--
-- Edge case not covered here: interest submitted → member added (admin/bot)
-- → member never signs in via magic link. The trigger fires on auth.users
-- so until they sign in there's a brief window where the link is unset.
-- Acceptable; the link materializes on first sign-in.

ALTER TABLE interests
  ADD COLUMN member_id BIGINT REFERENCES members(id) ON DELETE SET NULL;

CREATE INDEX idx_interests_member_id ON interests (member_id);

-- (a) Backfill existing rows
UPDATE interests i
SET member_id = m.id
FROM members m
WHERE LOWER(i.email) = LOWER(m.email)
  AND i.member_id IS NULL;

-- (b) Extend the migration-004 auth trigger to also link interests
CREATE OR REPLACE FUNCTION public.link_member_on_auth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Original behavior: link any matching members row to this auth user
  UPDATE members
  SET supabase_user_id = NEW.id
  WHERE email = NEW.email
    AND supabase_user_id IS NULL;

  -- New: link any matching interests row to the (now-resolvable) member
  UPDATE interests
  SET member_id = (
    SELECT id FROM members WHERE email = NEW.email LIMIT 1
  )
  WHERE email = NEW.email
    AND member_id IS NULL;

  RETURN NEW;
END;
$$;

-- (d) Let members read their own linked interest row.
-- The migration-019 policy was admin-only; without this, the /portal
-- "Thanks for joining our list on …" acknowledgment can't see the row
-- (it queries via the user's RLS-bound client). The existing admins_all
-- policy stays in place — RLS combines policies with OR, so admins still
-- see everything and members see only their own row.
CREATE POLICY "members_read_own" ON interests
  FOR SELECT USING (
    member_id = (SELECT id FROM members WHERE supabase_user_id = auth.uid())
  );
