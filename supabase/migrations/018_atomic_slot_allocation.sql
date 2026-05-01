-- Migration 018: Atomic PIN slot allocation
--
-- Adds partial unique indexes so two concurrent requests cannot both claim
-- the same PIN slot. Combined with INSERT-with-retry in the API routes
-- (apps/web/src/lib/slotAllocation.ts), this enforces correctness at the
-- database level even under contention.
--
-- Idempotent: safe to re-run.
--
-- WARNING: Will fail if existing rows already violate the constraint.
-- Before applying, check for duplicates:
--
--   SELECT pin_slot, COUNT(*) FROM day_codes
--   WHERE is_active = true GROUP BY pin_slot HAVING COUNT(*) > 1;
--
--   SELECT pin_code_slot, COUNT(*) FROM members
--   WHERE pin_code_slot IS NOT NULL GROUP BY pin_code_slot HAVING COUNT(*) > 1;
--
-- If either returns rows, deactivate or fix the duplicates first.

-- One active day code per slot (slots 101-200 per migration 006).
CREATE UNIQUE INDEX IF NOT EXISTS day_codes_active_slot_unique
  ON day_codes (pin_slot)
  WHERE is_active = true;

-- One member per slot (slots 1-100 per migration 006).
CREATE UNIQUE INDEX IF NOT EXISTS members_pin_code_slot_unique
  ON members (pin_code_slot)
  WHERE pin_code_slot IS NOT NULL;
