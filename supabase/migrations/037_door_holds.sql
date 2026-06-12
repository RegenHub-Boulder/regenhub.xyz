-- Migration 037: Door hold-opens (happy hour mode)
--
-- A "hold" keeps door(s) unlocked until a set time, driven by the Telegram
-- bot's /holdopen command. The bot re-unlocks held doors every 4 minutes;
-- Home Assistant's own auto-lock automation (5 min) stays untouched, so if
-- the bot dies the doors fail back to LOCKED within minutes. Default-safe.
--
-- Persisting holds here (not in bot memory) means a bot restart mid-party
-- resumes the keep-alive instead of silently dropping it.

create table door_holds (
  id                    serial primary key,
  doors                 text[] not null,        -- entity ids, e.g. {lock.front_door_lock}
  hold_until            timestamptz not null,
  created_by_member_id  integer references members(id) on delete set null,
  created_at            timestamptz not null default now(),
  released_at           timestamptz,            -- set on relock (expiry or manual)
  released_reason       text,                   -- 'expired' | 'manual' | 'superseded'
  warned_at             timestamptz             -- 10-min warning sent
);

create index door_holds_active_idx on door_holds (hold_until)
  where released_at is null;

alter table door_holds enable row level security;

create policy "admins_read_door_holds" on door_holds
  for select using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

-- Writes via service-role (the bot) only.
