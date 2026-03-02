-- Automatically link a members row to a Supabase auth user when they sign in.
--
-- When a new auth.users row is created (first magic-link sign-in) or when an
-- existing one is updated (e.g. email confirmed), this trigger finds any
-- members record with a matching email that hasn't been linked yet and sets
-- its supabase_user_id. This lets admins pre-create members by email; the
-- moment the member signs in their portal access is active automatically.

CREATE OR REPLACE FUNCTION public.link_member_on_auth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE members
  SET supabase_user_id = NEW.id
  WHERE email = NEW.email
    AND supabase_user_id IS NULL;
  RETURN NEW;
END;
$$;

-- Fire on INSERT (first sign-in) and on email-confirmed UPDATE
DROP TRIGGER IF EXISTS on_auth_user_upsert ON auth.users;
CREATE TRIGGER on_auth_user_upsert
  AFTER INSERT OR UPDATE OF email, email_confirmed_at
  ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.link_member_on_auth();
