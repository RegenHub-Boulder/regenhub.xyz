-- Fix infinite recursion in admins_all_members RLS policy.
-- The original policy queried the members table from within a members
-- policy, causing infinite recursion. Replaced with a SECURITY DEFINER
-- function that bypasses RLS for the admin check.

CREATE OR REPLACE FUNCTION is_admin_user(user_uuid uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS
$$ SELECT EXISTS (SELECT 1 FROM members WHERE supabase_user_id = user_uuid AND is_admin = true) $$;

DROP POLICY IF EXISTS admins_all_members ON members;

CREATE POLICY admins_all_members ON members
  FOR ALL
  USING (is_admin_user(auth.uid()));
