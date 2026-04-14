-- Migration 017: Add optional telegram username to applications.
-- Lets applicants share their Telegram handle so the member coordinator
-- can reach out via Telegram in addition to email.
ALTER TABLE applications ADD COLUMN telegram TEXT;
