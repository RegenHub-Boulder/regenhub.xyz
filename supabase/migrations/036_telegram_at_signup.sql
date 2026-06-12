-- Migration 036: Capture Telegram handle at free-day signup + handle op-sec
--
-- Two things:
--
-- 1) free_day_claims gets a `telegram` column so the signup form can collect
--    it, and the member-creation trigger carries it onto the new member row.
--
-- 2) Op-sec: a case-insensitive UNIQUE index on members.telegram_username.
--    The bot resolves members by the SENDER's handle (verified by Telegram
--    itself), so if someone claimed another person's handle on their member
--    row, the real owner would resolve to the wrong member when they message
--    the bot. Uniqueness closes that hole — a handle can only live on one
--    member row. (Checked before applying: zero duplicate handles in prod.)
--
--    Handles are stored WITHOUT the leading @ going forward, but historic
--    rows may have it — the index normalizes both @ and case.

alter table free_day_claims add column telegram text;

create unique index members_telegram_username_unique
  on members (lower(replace(telegram_username, '@', '')))
  where telegram_username is not null and telegram_username != '';

-- Carry telegram from claim → member, but only when the handle isn't already
-- claimed by another member (the unique index would reject the insert and
-- break member creation entirely — degrading to NULL is the right behavior;
-- an admin can resolve the conflict by hand if it ever matters).
create or replace function create_day_pass_member_on_approval()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_telegram text;
begin
  if new.status = 'reserved' and (tg_op = 'INSERT' or old.status is distinct from 'reserved') then
    -- Normalize: strip @, empty → null
    v_telegram := nullif(replace(coalesce(new.telegram, ''), '@', ''), '');
    -- Drop the handle if another member already holds it (case-insensitive)
    if v_telegram is not null and exists (
      select 1 from members
       where lower(replace(coalesce(telegram_username, ''), '@', '')) = lower(v_telegram)
    ) then
      v_telegram := null;
    end if;

    if not exists (select 1 from members where email = new.email) then
      insert into members (name, email, member_type, day_passes_balance, supabase_user_id, telegram_username)
      values (new.name, new.email, 'day_pass', 1, new.supabase_user_id, v_telegram);
    else
      update members
         set day_passes_balance = day_passes_balance + 1,
             telegram_username = coalesce(telegram_username, v_telegram)
       where email = new.email;
    end if;
  end if;
  return new;
end;
$$;
