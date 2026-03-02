-- Allow members to update their own row.
-- Needed for: portal profile edits (name, bio, skills, etc.)
-- and pin_code updates via regenerate-code API.
-- The admins_all_members policy already covers admins (FOR ALL).

CREATE POLICY members_update_own ON members
  FOR UPDATE
  USING (supabase_user_id = auth.uid());
