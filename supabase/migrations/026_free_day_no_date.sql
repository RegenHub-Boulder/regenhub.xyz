-- Migration 026: Free-day claims no longer require a date upfront
--
-- The form used to ask "what day will you visit?" and store it. New flow:
-- claim now, visit whenever (any weekday during business hours). The
-- activate endpoint checks the day-of-week + hours; no upfront commitment.

alter table free_day_claims alter column claimed_date drop not null;
