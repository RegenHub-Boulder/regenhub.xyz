-- Migration 061: bind members to a numeric Telegram user id.
--
-- The bot used to identify people by @username only. Telegram usernames are
-- releasable and re-claimable, so a recycled handle inherited that member's
-- door and admin commands. Numeric ids never get reused.
--
-- Binding is trust-on-first-use, done by the bot with the service role: the
-- first time a member whose telegram_user_id is NULL messages the bot, the id
-- Telegram attached to that message is stored. From then on a sender whose id
-- differs is treated as unregistered (no door, admin or invite commands).
--
-- NOT applied automatically. Additive and nullable, so the existing bot keeps
-- working before and after it is applied.

alter table members add column if not exists telegram_user_id bigint;

create unique index if not exists members_telegram_user_id_unique
  on members (telegram_user_id)
  where telegram_user_id is not null;

-- If an admin points a member at a different @handle, the old numeric binding
-- belongs to the previous holder: drop it so the new person can bind on first
-- contact. (A statement that sets both columns together is respected.)
create or replace function members_reset_telegram_user_id() returns trigger
language plpgsql as $$
begin
  if new.telegram_username is distinct from old.telegram_username
     and new.telegram_user_id is not distinct from old.telegram_user_id then
    new.telegram_user_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists members_reset_telegram_user_id on members;
create trigger members_reset_telegram_user_id
  before update of telegram_username on members
  for each row execute function members_reset_telegram_user_id();

-- Members must not be able to set or clear their own binding through the
-- RLS-permitted self-update policy (003_members_update_own). A column REVOKE
-- would not override a table-level UPDATE grant, so enforce it in a trigger:
-- requests arriving as anon/authenticated (PostgREST JWT roles) keep the old
-- value. The bot and admin SQL (service_role / postgres) are unaffected.
create or replace function members_protect_telegram_user_id() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') in ('anon', 'authenticated')
     and new.telegram_user_id is distinct from old.telegram_user_id then
    new.telegram_user_id := old.telegram_user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists members_protect_telegram_user_id on members;
create trigger members_protect_telegram_user_id
  before update on members
  for each row execute function members_protect_telegram_user_id();
