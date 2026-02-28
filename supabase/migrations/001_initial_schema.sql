-- =====================================================
-- RegenHub Initial Schema
-- Migrated and extended from regen-door-manager
-- =====================================================

-- Custom types
create type member_type as enum ('full', 'daypass');
create type membership_tier as enum ('community', 'coworking', 'cooperative');
create type access_method as enum ('nfc', 'pin', 'daycode');

-- =====================================================
-- Members
-- Extended from door-manager's Users model
-- =====================================================
create table members (
  id                 serial primary key,
  supabase_user_id   uuid references auth.users(id) on delete set null,

  -- Core identity
  name               text not null,
  email              text unique,
  telegram_username  text unique,
  ethereum_address   text,

  -- Access credentials
  nfc_key_address    text unique,
  pin_code           text check (pin_code ~ '^\d{4,10}$' or pin_code is null),
  pin_code_slot      integer check (pin_code_slot > 0 and pin_code_slot < 125),

  -- Membership
  member_type        member_type not null default 'full',
  membership_tier    membership_tier not null default 'coworking',
  is_admin           boolean not null default false,
  disabled           boolean not null default false,

  -- Profile
  bio                text,
  skills             text[],
  profile_photo_url  text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- =====================================================
-- Day Passes
-- A pool of N uses for a member
-- =====================================================
create table day_passes (
  id            serial primary key,
  member_id     integer not null references members(id) on delete cascade,
  allowed_uses  integer not null default 1 check (allowed_uses >= 1),
  used_count    integer not null default 0 check (used_count >= 0),
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- =====================================================
-- Day Codes
-- Temporary door codes issued against a day pass or by full members
-- PIN slots 125-249 reserved for temporary codes
-- =====================================================
create table day_codes (
  id            serial primary key,
  day_pass_id   integer references day_passes(id) on delete set null,
  member_id     integer references members(id) on delete set null,
  label         text,
  code          text not null check (code ~ '^\d{5,6}$'),
  pin_slot      integer not null check (pin_slot >= 125 and pin_slot <= 249),
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- =====================================================
-- Access Logs
-- Record of every access attempt (NFC, PIN, day code)
-- =====================================================
create table access_logs (
  id         serial primary key,
  member_id  integer references members(id) on delete set null,
  method     access_method not null,
  slot       integer,
  result     text not null check (result in ('granted', 'denied')),
  note       text,
  created_at timestamptz not null default now()
);

-- =====================================================
-- Updated_at trigger
-- =====================================================
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger members_updated_at    before update on members    for each row execute function set_updated_at();
create trigger day_passes_updated_at before update on day_passes for each row execute function set_updated_at();
create trigger day_codes_updated_at  before update on day_codes  for each row execute function set_updated_at();

-- =====================================================
-- Indexes
-- =====================================================
create index on members (email);
create index on members (telegram_username);
create index on members (nfc_key_address);
create index on members (supabase_user_id);
create index on day_passes (member_id);
create index on day_codes (is_active) where is_active = true;
create index on day_codes (expires_at) where is_active = true;
create index on day_codes (member_id);
create index on access_logs (member_id);
create index on access_logs (created_at desc);

-- =====================================================
-- Row Level Security
-- =====================================================
alter table members    enable row level security;
alter table day_passes enable row level security;
alter table day_codes  enable row level security;
alter table access_logs enable row level security;

-- Members can read their own record
create policy "members_read_own" on members
  for select using (supabase_user_id = auth.uid());

-- Admins can read/write all members
create policy "admins_all_members" on members
  for all using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

-- Members can read their own day passes
create policy "members_read_own_passes" on day_passes
  for select using (
    member_id in (select id from members where supabase_user_id = auth.uid())
  );

-- Admins can do everything with day passes
create policy "admins_all_passes" on day_passes
  for all using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

-- Members can read their own day codes
create policy "members_read_own_codes" on day_codes
  for select using (
    member_id in (select id from members where supabase_user_id = auth.uid())
  );

-- Admins can do everything with day codes
create policy "admins_all_codes" on day_codes
  for all using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

-- Access logs: admins read all, members read own
create policy "admins_read_logs" on access_logs
  for select using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

create policy "members_read_own_logs" on access_logs
  for select using (
    member_id in (select id from members where supabase_user_id = auth.uid())
  );

-- Service role bypasses all RLS (used by Telegram bot + door manager)
