-- Migration 013: Reverse-link member to auth user when member email is set
--
-- The existing trigger (004) links members to auth users when an auth.users
-- row is created/updated. But it doesn't handle the reverse case: a member
-- who already exists (e.g. created via Telegram bot) later sets their email
-- to match an existing auth user. This trigger closes that gap.

CREATE OR REPLACE FUNCTION public.link_member_to_auth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- When a member's email is set or changed and they have no auth link yet,
  -- try to find a matching auth user and link them.
  IF NEW.email IS NOT NULL AND NEW.supabase_user_id IS NULL THEN
    NEW.supabase_user_id := (
      SELECT id FROM auth.users
      WHERE email = NEW.email
      LIMIT 1
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_member_email_changed
  BEFORE UPDATE OF email ON members
  FOR EACH ROW
  WHEN (NEW.email IS DISTINCT FROM OLD.email)
  EXECUTE FUNCTION public.link_member_to_auth();
