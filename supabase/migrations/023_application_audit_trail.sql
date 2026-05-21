-- Migration 023: Application audit trail
--
-- Tracks who approved / rejected each application and when. Important for a
-- cooperative — knowing who made the call matters for accountability.
--
-- approved_by / rejected_by reference members.id (the admin member). Set NULL
-- on member delete so we keep the timestamp + decision even if the admin
-- account is later removed.

alter table applications
  add column approved_by integer references members(id) on delete set null,
  add column rejected_by integer references members(id) on delete set null,
  add column rejected_at timestamptz;

-- Note: approved_at already exists implicitly via checkout_sent_at (set in the
-- approve route). We could add a separate approved_at, but it'd be redundant.
-- If we want a pure decision timestamp later, easy to add.
