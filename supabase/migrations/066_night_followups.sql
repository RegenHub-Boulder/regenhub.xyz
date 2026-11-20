-- Migration 066: a short note the day after a RegenHub night, to the people who RSVP'd (T-497).
--
-- /admin/events lists each night that ended in the last few days with who would get a note and which one (member
-- or guest). Nothing goes out until a Techne steward of RegenHub clicks Send; Skip closes the night. The list is
-- worked out on the page from the night's RSVPs (lib/nightFollowups.ts); this migration only records decisions
-- and sends, and enforces the limits at the moment of sending:
--
--   night_followup_optouts   per-person "no follow-ups after nights" (the link in every note), by email
--   night_followup_batches   one row per night once a steward decided: send or skip. A night is decided once.
--   night_followups          one row per person in a sent batch: who, which note, sent / failed / held (and why)
--   decide_night_followups   the decision in one transaction: the batch row, a row per person (held if they
--                            unsubscribed from email, opted out of follow-ups, or got a follow-up in the last 7
--                            days), and the admin_actions row. Answers the rows to send.
--
-- The scoreboard reads night_followups (sent, guest note) for "followed up → joined within 30 days".
-- Server-only: RLS on, no policies, the function granted to service_role alone. Additive.
-- Reverse: drop function decide_night_followups(text, text, timestamptz, text, text, jsonb);
--   drop table night_followups, night_followup_batches, night_followup_optouts;
set local lock_timeout = '5s';

create table night_followup_optouts (
  email      text primary key check (email = lower(email)),
  source     text not null default 'link',
  created_at timestamptz not null default now()
);
alter table night_followup_optouts enable row level security;
revoke all on night_followup_optouts from public, anon, authenticated;

create table night_followup_batches (
  id             bigserial primary key,
  event_uri      text not null unique,
  event_name     text not null,
  event_start    timestamptz,
  decision       text not null check (decision in ('send', 'skip')),
  -- the steward's Techne DID (a steward needn't have a members row)
  decided_by_did text not null,
  decided_at     timestamptz not null default now()
);
alter table night_followup_batches enable row level security;
revoke all on night_followup_batches from public, anon, authenticated;

create table night_followups (
  id          bigserial primary key,
  batch_id    bigint not null references night_followup_batches(id) on delete cascade,
  event_uri   text not null,
  member_id   integer references members(id) on delete set null,
  email       text not null check (email = lower(email)),
  variant     text not null check (variant in ('member', 'guest')),
  status      text not null check (status in ('sending', 'sent', 'failed', 'held')),
  -- held: 'unsubscribed' | 'opted_out' | 'this_week'
  held_reason text,
  provider_id text,
  error       text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  unique (batch_id, email)
);
create index night_followups_email_idx on night_followups (email, created_at desc);
create index night_followups_member_idx on night_followups (member_id, created_at desc);
alter table night_followups enable row level security;
revoke all on night_followups from public, anon, authenticated;

-- A steward's decision on one night. p_people: [{ "member_id": 1, "email": "a@b.c", "variant": "guest" }, ...], the
-- people the steward saw and kept. Raises 'night_followups_decided' if the night was already decided. Each person is
-- checked under a lock on their email, so two nights sent at once can't both reach them in the same week.
create function decide_night_followups(
  p_event_uri text, p_event_name text, p_event_start timestamptz, p_decision text, p_actor_did text, p_people jsonb
) returns table (id bigint, member_id integer, email text, variant text, status text, held_reason text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_batch bigint;
  v_person jsonb;
  v_email text;
  v_reason text;
begin
  if p_decision not in ('send', 'skip') then
    raise exception 'night_followups_bad_decision';
  end if;
  insert into night_followup_batches (event_uri, event_name, event_start, decision, decided_by_did)
    values (p_event_uri, p_event_name, p_event_start, p_decision, p_actor_did)
    on conflict (event_uri) do nothing
    returning night_followup_batches.id into v_batch;
  if v_batch is null then
    raise exception 'night_followups_decided';
  end if;

  if p_decision = 'send' then
    for v_person in
      select value from jsonb_array_elements(coalesce(p_people, '[]'::jsonb)) order by lower(value->>'email')
    loop
      v_email := lower(trim(v_person->>'email'));
      if v_email is null or v_email = '' or v_person->>'variant' not in ('member', 'guest') then
        continue;
      end if;
      perform pg_advisory_xact_lock(hashtext('night_followup:' || v_email));
      v_reason := case
        when exists (select 1 from email_unsubscribes u where lower(u.email) = v_email) then 'unsubscribed'
        when exists (select 1 from night_followup_optouts o where o.email = v_email) then 'opted_out'
        when exists (select 1 from night_followups f
                       where f.email = v_email and f.status in ('sending', 'sent')
                         and f.created_at > now() - interval '7 days') then 'this_week'
        else null
      end;
      insert into night_followups (batch_id, event_uri, member_id, email, variant, status, held_reason)
        values (v_batch, p_event_uri, nullif(v_person->>'member_id', '')::integer, v_email, v_person->>'variant',
                case when v_reason is null then 'sending' else 'held' end, v_reason)
        on conflict on constraint night_followups_batch_id_email_key do nothing;
    end loop;
  end if;

  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
    values (
      (select m.id from members m where m.did = p_actor_did limit 1),
      'night_followups_decided', 'night_followup_batches', v_batch::text,
      jsonb_build_object('event_uri', p_event_uri, 'event_name', p_event_name, 'decision', p_decision,
                         'by_did', p_actor_did,
                         'sending', (select count(*) from night_followups f where f.batch_id = v_batch and f.status = 'sending'),
                         'held', (select count(*) from night_followups f where f.batch_id = v_batch and f.status = 'held')));

  return query
    select f.id, f.member_id, f.email, f.variant, f.status, f.held_reason
      from night_followups f where f.batch_id = v_batch order by f.id;
end;
$$;
revoke all on function decide_night_followups(text, text, timestamptz, text, text, jsonb) from public, anon, authenticated;
grant execute on function decide_night_followups(text, text, timestamptz, text, text, jsonb) to service_role;
