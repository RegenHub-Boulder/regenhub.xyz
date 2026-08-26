-- Migration 047: application workflow fields are server/admin-owned.
--
-- Migration 005 gave applicants FOR ALL access to their row. That also made
-- approval, approved plan, and approved rate fields writable through the
-- public REST API. Application writes now go through the validated server
-- route; authenticated applicants retain read-only access to their own row.

drop policy if exists "applicants_own" on applications;

create policy "applicants_read_own" on applications
  for select
  using (supabase_user_id = auth.uid());

