-- Migration 014: Free day claims — one free coworking day per person
--
-- Supports the /freeday pipeline growth page. Anyone can claim a free day
-- by providing their email. The email auth requirement also builds our list.

CREATE TABLE free_day_claims (
  id              SERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,          -- one free day per email, ever
  name            TEXT NOT NULL,
  supabase_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  claimed_date    DATE NOT NULL,                 -- the day they want to use
  day_code_id     INTEGER REFERENCES day_codes(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'reserved'
                  CHECK (status IN ('reserved', 'activated', 'expired', 'cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at    TIMESTAMPTZ
);

CREATE INDEX ON free_day_claims (supabase_user_id);
CREATE INDEX ON free_day_claims (email);
CREATE INDEX ON free_day_claims (status) WHERE status = 'reserved';

ALTER TABLE free_day_claims ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read their own claim
CREATE POLICY "own_claim_read" ON free_day_claims
  FOR SELECT USING (supabase_user_id = auth.uid());

-- Authenticated users can update their own claim (for activation)
CREATE POLICY "own_claim_update" ON free_day_claims
  FOR UPDATE USING (supabase_user_id = auth.uid());

-- Admins can do everything
CREATE POLICY "admins_all_free_day" ON free_day_claims
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM members
      WHERE supabase_user_id = auth.uid() AND is_admin = true
    )
  );

-- Auto-link: when an auth user is created/updated, link any matching claim by email
CREATE OR REPLACE FUNCTION public.link_free_day_on_auth()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE free_day_claims
  SET supabase_user_id = NEW.id
  WHERE email = NEW.email AND supabase_user_id IS NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_link_free_day
  AFTER INSERT OR UPDATE OF email, email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.link_free_day_on_auth();
