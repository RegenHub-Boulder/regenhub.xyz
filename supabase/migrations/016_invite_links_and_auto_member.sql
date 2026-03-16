-- Migration 016: Invite links + auto-create day_pass member on free day approval
--
-- Co-op members get a personal invite_code they can share.
-- When a free_day_claim transitions to 'reserved' (via invite or Telegram approval),
-- a day_pass member record is automatically created.

-- 1. Add invite code column to members (co-op members share this link)
ALTER TABLE members ADD COLUMN invite_code TEXT UNIQUE;

-- 2. Track who invited someone on free_day_claims
ALTER TABLE free_day_claims ADD COLUMN invited_by_member_id INTEGER REFERENCES members(id);

-- 3. Auto-create day_pass member when free day claim is approved
CREATE OR REPLACE FUNCTION create_day_pass_member_on_approval()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Only act when status transitions TO 'reserved'
  IF NEW.status = 'reserved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'reserved') THEN
    -- Don't create if member already exists with this email
    IF NOT EXISTS (SELECT 1 FROM members WHERE email = NEW.email) THEN
      INSERT INTO members (name, email, member_type, day_passes_balance, supabase_user_id)
      VALUES (NEW.name, NEW.email, 'day_pass', 0, NEW.supabase_user_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_free_day_approved
  AFTER INSERT OR UPDATE OF status ON free_day_claims
  FOR EACH ROW
  WHEN (NEW.status = 'reserved')
  EXECUTE FUNCTION create_day_pass_member_on_approval();
