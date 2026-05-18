-- Migration 021: Stripe-powered recurring memberships
--
-- Adds:
--   - members.stripe_customer_id           (one Stripe customer per member)
--   - subscriptions                        (local mirror of Stripe subscription state)
--   - purchases                            (audit log of one-time buys: day_pass, five_pack)
--   - applications.approved_plan_key + pricing/discount/checkout cols
--
-- Plans are identified by free-text `plan_key` (not enum) so adding new
-- tiers (e.g. social, events-only) doesn't require a schema migration.
-- Plan metadata lives in apps/web/src/lib/stripe.ts.
--
-- Stripe is the source of truth for subscription state; these local tables
-- exist so the app can query cheaply (e.g. "who's past due") without
-- round-tripping to Stripe.

-- =====================================================
-- 1. members.stripe_customer_id
-- =====================================================
alter table members add column stripe_customer_id text unique;
create index on members (stripe_customer_id);

-- =====================================================
-- 2. subscriptions — mirrors Stripe.Subscription state
-- =====================================================
create table subscriptions (
  id                       serial primary key,
  member_id                integer not null references members(id) on delete cascade,
  stripe_subscription_id   text not null unique,
  stripe_customer_id       text not null,
  stripe_price_id          text not null,
  -- Free text — keys defined in apps/web/src/lib/stripe.ts PLANS constant
  plan_key                 text not null,
  -- Actual monthly amount charged (set dynamically per subscription, not from a fixed Price)
  monthly_cents            integer not null,
  -- mirrors Stripe status: active | past_due | canceled | incomplete | incomplete_expired | trialing | unpaid | paused
  status                   text not null,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean not null default false,
  canceled_at              timestamptz,
  -- set when invoice.payment_failed fires; cleared on payment_succeeded
  past_due_since           timestamptz,
  -- set by the past-due-sweep cron after the 7-day grace expires
  access_disabled_at       timestamptz,
  -- snapshot of any time-bounded promo Coupon (rate adjustments are baked
  -- into monthly_cents; Coupons used only for "$X off for N months" deals)
  discount_cents           integer,
  discount_duration        text check (discount_duration in ('forever', 'repeating') or discount_duration is null),
  discount_months          integer,
  discount_note            text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index on subscriptions (member_id);
create index on subscriptions (status);
create index on subscriptions (plan_key);
create index on subscriptions (past_due_since) where past_due_since is not null;

create trigger subscriptions_updated_at before update on subscriptions
  for each row execute function set_updated_at();

-- =====================================================
-- 3. purchases — audit log of one-time buys
-- =====================================================
create table purchases (
  id                       serial primary key,
  member_id                integer references members(id) on delete set null,
  stripe_checkout_session  text unique,
  stripe_payment_intent    text,
  kind                     text not null check (kind in ('day_pass', 'five_pack')),
  amount_cents             integer not null,
  passes_granted           integer not null,
  email                    text,
  created_at               timestamptz not null default now()
);

create index on purchases (member_id);
create index on purchases (email);

-- =====================================================
-- 3b. pass_grants — idempotent ledger of monthly day-pass grants
-- =====================================================
-- For social tiers (e.g. social_events_1, social_events_5) that grant N day
-- passes per billing cycle. Each grant is keyed by the Stripe invoice ID
-- to ensure idempotency — if Stripe redelivers invoice.payment_succeeded,
-- the duplicate INSERT fails on the UNIQUE constraint and we skip the
-- balance increment.
create table pass_grants (
  id                       serial primary key,
  member_id                integer not null references members(id) on delete cascade,
  subscription_id          integer references subscriptions(id) on delete set null,
  stripe_invoice_id        text not null unique,
  plan_key                 text not null,
  passes_granted           integer not null,
  created_at               timestamptz not null default now()
);

create index on pass_grants (member_id);
create index on pass_grants (subscription_id);

-- =====================================================
-- 4. applications — admin-set plan + pricing + checkout state
-- =====================================================
alter table applications
  add column approved_plan_key text,
  add column approved_monthly_cents integer,
  add column discount_cents integer,
  add column discount_duration text check (discount_duration in ('forever', 'repeating') or discount_duration is null),
  add column discount_months integer,
  add column discount_note text,
  add column stripe_checkout_session_id text,
  add column stripe_checkout_url text,
  add column checkout_sent_at timestamptz,
  add column checkout_completed_at timestamptz;

-- =====================================================
-- 5. RLS
-- =====================================================
alter table subscriptions enable row level security;
alter table purchases enable row level security;
alter table pass_grants enable row level security;

-- Members can read their own subscription rows
create policy "members_read_own_subscriptions" on subscriptions
  for select using (
    member_id in (select id from members where supabase_user_id = auth.uid())
  );

-- Admins can do everything on subscriptions
create policy "admins_all_subscriptions" on subscriptions
  for all using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

-- Members can read their own purchases
create policy "members_read_own_purchases" on purchases
  for select using (
    member_id in (select id from members where supabase_user_id = auth.uid())
  );

-- Admins can do everything on purchases
create policy "admins_all_purchases" on purchases
  for all using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

-- Members can read their own pass grants (so portal can show "1 pass granted on Mar 5")
create policy "members_read_own_pass_grants" on pass_grants
  for select using (
    member_id in (select id from members where supabase_user_id = auth.uid())
  );

-- Admins can do everything on pass_grants
create policy "admins_all_pass_grants" on pass_grants
  for all using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

-- service_role bypasses RLS (used by webhook handler + admin routes)
