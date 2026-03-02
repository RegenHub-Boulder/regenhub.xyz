-- Migration 005: Application form + member directory opt-out

-- Applications table: stores membership applications (before a member row is created)
CREATE TABLE applications (
  id SERIAL PRIMARY KEY,
  supabase_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  about TEXT,                          -- what they work on / short bio
  why_join TEXT,                       -- why they want to join RegenHub
  membership_interest TEXT DEFAULT 'community',  -- community | coworking | cooperative
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | approved | rejected
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;

-- Authenticated applicants can read/update their own application
CREATE POLICY "applicants_own" ON applications
  FOR ALL USING (supabase_user_id = auth.uid());

-- Admins can do everything
CREATE POLICY "admins_all" ON applications
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM members
      WHERE supabase_user_id = auth.uid() AND is_admin = true
    )
  );

-- Trigger: when an auth user is created/updated, link any matching application by email
CREATE OR REPLACE FUNCTION public.link_application_on_auth()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE applications
  SET supabase_user_id = NEW.id
  WHERE email = NEW.email AND supabase_user_id IS NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_link_application
  AFTER INSERT OR UPDATE OF email, email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.link_application_on_auth();

-- Add directory opt-out to members (default: show in directory)
ALTER TABLE members ADD COLUMN show_in_directory BOOLEAN NOT NULL DEFAULT true;
