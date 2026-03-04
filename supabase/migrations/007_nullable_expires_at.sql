-- Allow day codes with no expiry (manually revoked only)
alter table day_codes alter column expires_at drop not null;
