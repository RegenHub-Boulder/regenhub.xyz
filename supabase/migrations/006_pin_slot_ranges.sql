-- =====================================================
-- Fix PIN slot ranges
--
-- Slot layout (conservative, fits any Z-Wave lock):
--   1–100   → permanent member PINs
--   101–200 → temporary day-code PINs
--
-- Previously members allowed 1–124 and day_codes 125–249.
-- Tightening both to avoid hardware errors on locks with
-- fewer supported user codes, and adding a UNIQUE constraint
-- so two members can never share a slot.
-- =====================================================

-- Members: fix constraint and add unique
alter table members
  drop constraint if exists members_pin_code_slot_check;

alter table members
  add constraint members_pin_code_slot_check
  check (pin_code_slot >= 1 and pin_code_slot <= 100);

alter table members
  drop constraint if exists members_pin_code_slot_key;

alter table members
  add constraint members_pin_code_slot_key
  unique (pin_code_slot);

-- Day codes: fix constraint
alter table day_codes
  drop constraint if exists day_codes_pin_slot_check;

alter table day_codes
  add constraint day_codes_pin_slot_check
  check (pin_slot >= 101 and pin_slot <= 200);
