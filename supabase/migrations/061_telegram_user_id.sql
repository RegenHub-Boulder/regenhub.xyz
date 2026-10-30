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

-- If a member is pointed at a different @handle (admin edit, profile edit,
-- application approval), the old numeric binding belongs to the previous
-- holder: drop it so the new person can bind on first contact. (A statement
-- that sets both columns together is respected.) Handles are compared in 044's
-- canonical form, case-folded as Telegram does, so re-saving "@Alice" as
-- "alice" (the admin form re-sends the handle on every save) keeps the binding.
create or replace function members_reset_telegram_user_id() returns trigger
language plpgsql as $$
begin
  if lower(nullif(btrim(regexp_replace(new.telegram_username, '^@+', '')), ''))
       is distinct from lower(nullif(btrim(regexp_replace(old.telegram_username, '^@+', '')), ''))
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

-- Members must never set or clear their own binding. Today anon/authenticated
-- can't UPDATE members at all (031 revoked it), so this is the second lock in
-- case a later migration grants it back: a write running as one of those roles
-- keeps the old value. It checks current_user, the role PostgREST switches to
-- for the request, not the request.jwt.claim.* settings, which current
-- PostgREST no longer sets. The bot and admin routes (service_role) and
-- SECURITY DEFINER functions are unaffected.
create or replace function members_protect_telegram_user_id() returns trigger
language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated')
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
