-- Migration 024: Webhook delivery log
--
-- Every Stripe webhook event is logged here for ops visibility.
-- Admin can see: what events came in, did we process them, did anything
-- fail. Critical for diagnosing "I paid but my balance didn't update"
-- and "did Stripe actually deliver that?".
--
-- We log on ingest (not on success) so failed signature verifications
-- or thrown handlers still leave a trail.

create table webhook_events (
  id                       serial primary key,
  -- Stripe event ID — unique. Stripe redelivers with the same ID on retry,
  -- so this enables exactly-once logging across retries.
  stripe_event_id          text not null unique,
  event_type               text not null,
  -- 'processing' | 'ok' | 'data_error' | 'error'
  status                   text not null default 'processing',
  -- Free-form error message when status is data_error or error
  error_message            text,
  -- Resolved member id if we figured out who the event was for
  member_id                integer references members(id) on delete set null,
  -- How long the handler took (ms) — useful for spotting slow events
  duration_ms              integer,
  received_at              timestamptz not null default now(),
  completed_at             timestamptz
);

create index on webhook_events (received_at desc);
create index on webhook_events (status);
create index on webhook_events (event_type);
create index on webhook_events (member_id) where member_id is not null;

alter table webhook_events enable row level security;

-- Only admins can read the log (visible from /admin/billing)
create policy "admins_read_webhook_events" on webhook_events
  for select using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

-- service_role bypasses RLS — the webhook handler writes via the service client
