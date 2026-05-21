-- Migration 022: Capture "who do you know at the hub?" on free-day claims
--
-- A claimant's connection to existing members gives admins context when
-- reviewing the Telegram notification — they can recognize the referral
-- and reach out / approve faster.
--
-- Optional field; existing rows stay NULL.

alter table free_day_claims add column know_at_hub text;
