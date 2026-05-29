-- Migration 031: Lock down direct UPDATE on members
--
-- Migration 003 ("members_update_own") let an authenticated user run
-- `supabase.from('members').update({...})` directly via the anon JS SDK,
-- with no `WITH CHECK` clause. That meant any logged-in member could flip
-- their own row's `is_admin = true`, `day_passes_balance = 9999`, or
-- `pin_code = '1234'` — privilege escalation in one line.
--
-- Self-service writes now have to go through application routes (notably
-- `/api/portal/profile` and `/api/portal/regenerate-code`) which use the
-- service-role client and whitelist the writeable columns.
--
-- READ access stays open under existing policies — we just close UPDATE.

drop policy if exists "members_update_own" on members;

-- Belt-and-suspenders: even if a future migration re-adds a policy, the
-- role-level REVOKE means the SDK can't UPDATE without a service-role key.
revoke update on members from authenticated;
revoke update on members from anon;
