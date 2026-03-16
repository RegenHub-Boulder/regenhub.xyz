-- Migration 015: Add promo code + application approval fields to free_day_claims
-- Supports two paths: instant access via promo code, or Telegram-approved application

-- Add application fields + promo code + approval tracking
ALTER TABLE free_day_claims
  ADD COLUMN about        TEXT,
  ADD COLUMN why_join     TEXT,
  ADD COLUMN promo_code   TEXT,
  ADD COLUMN approved_by  TEXT;  -- Telegram username of approver

-- Expand status CHECK to include 'pending'
ALTER TABLE free_day_claims
  DROP CONSTRAINT free_day_claims_status_check,
  ADD CONSTRAINT free_day_claims_status_check
    CHECK (status IN ('pending', 'reserved', 'activated', 'expired', 'cancelled'));
