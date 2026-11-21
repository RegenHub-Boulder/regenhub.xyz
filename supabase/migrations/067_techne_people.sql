-- Migration 067: every "Sign in with Techne" leaves a known person with an email (T-497).
--
-- The sign-in now asks for the person's email (scope transition:email, lib/techne/session.ts) and reads it from their
-- PDS (com.atproto.server.getSession: email + emailConfirmed). /techne/callback records them here, every sign-in.
--
--   techne_people               one row per Techne account that ever signed in here: DID, handle, display name, email
--                               and whether the PDS says it is confirmed, the member it belongs to (if any), whether it
--                               was put on the stay-in-touch list, first and last sign-in.
--   record_techne_sign_in       the callback's write, one transaction: save the person, link a member, and add a
--                               confirmed email to the stay-in-touch list (interests, source_path 'techne') unless it
--                               is already on it (an interests row or a member), unsubscribed, or the person said no.
--   decline_techne_newsletter   "No thanks": takes the person back off the list (only the row this added) and remembers it.
--
-- Why a table of its own and not a `did` column on interests: interests is the newsletter list, one row per signup
-- and email-keyed; a Techne person can have no email yet (signed in before this shipped, or no confirmed one), and
-- saying "No thanks" must leave no list row behind while still remembering the person. So: people here, the list there.
--
-- The member link (member_id) is for knowing who someone is (follow-ups, the steward page, admin): by members.did, or
-- else by a CONFIRMED email that matches exactly one member with no Techne account linked. It never writes
-- members.did and never opens the portal, a door code or billing: that still takes the emailed link
-- (confirm_techne_link, migration 064). An unconfirmed email links nothing and joins no list.
--
-- Server-only: RLS on, no policies, functions granted to service_role alone. Additive.
-- Reverse: drop function decline_techne_newsletter(text); drop function record_techne_sign_in(text, text, text, text, boolean);
--   drop table techne_people;
set local lock_timeout = '5s';

create table techne_people (
  did             text primary key,
  handle          text,
  -- the Techne profile's display name at the last sign-in that had one (a greeting; never used to pick a member)
  name            text,
  -- null until a sign-in with the email scope read one
  email           text check (email = lower(email)),
  email_confirmed boolean not null default false,
  member_id       integer references members(id) on delete set null,
  -- how member_id was found: 'did' (members.did) or 'email' (confirmed email, member not linked to a Techne account)
  member_link     text check (member_link in ('did', 'email')),
  -- the stay-in-touch list: 'added' (this put them on it), 'already' (on it or a member), 'unsubscribed', 'declined'
  -- ("No thanks"). Null: not decided yet (no confirmed email so far).
  newsletter      text check (newsletter in ('added', 'already', 'unsubscribed', 'declined')),
  -- the email that decision was about: a new email on the PDS is looked at again ('declined' stays: it was about us)
  newsletter_email text,
  interest_id     bigint references interests(id) on delete set null,
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now()
);
create index techne_people_email_idx on techne_people (email) where email is not null;
create index techne_people_member_idx on techne_people (member_id) where member_id is not null;
alter table techne_people enable row level security;
revoke all on techne_people from public, anon, authenticated;

-- One sign-in. p_email null = no email read this time (the scope wasn't granted, the PDS didn't answer): what was saved
-- stays. Answers the member it is linked to and whether this sign-in just put the person on the list (the one-time
-- "We'll send you RegenHub news" line).
create function record_techne_sign_in(p_did text, p_handle text, p_name text, p_email text, p_email_confirmed boolean)
  returns table (member_id integer, member_link text, newsletter_added boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_person techne_people%rowtype;
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_member integer;
  v_link text;
  v_interest bigint;
  v_added boolean := false;
  v_decided boolean := false;
begin
  if p_did is null or p_did !~ '^did:[a-z]+:[A-Za-z0-9._:%-]+$' then
    raise exception 'techne_people_bad_did';
  end if;
  if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    v_email := null;
  end if;

  insert into techne_people as t (did, handle, name, email, email_confirmed)
    values (p_did, p_handle, nullif(trim(coalesce(p_name, '')), ''), v_email, v_email is not null and coalesce(p_email_confirmed, false))
    on conflict (did) do update set
      handle = coalesce(excluded.handle, t.handle),
      name = coalesce(excluded.name, t.name),
      email = case when v_email is null then t.email else excluded.email end,
      email_confirmed = case when v_email is null then t.email_confirmed else excluded.email_confirmed end,
      last_seen = now();
  select * into v_person from techne_people t where t.did = p_did for update;

  -- Who they are: members.did first; else a confirmed email matching exactly one member with no Techne account.
  select m.id into v_member from members m where m.did = p_did limit 1;
  if v_member is not null then
    v_link := 'did';
  elsif v_person.email is not null and v_person.email_confirmed then
    select min(m.id) into v_member from members m
     where lower(trim(m.email)) = v_person.email and m.did is null
    having count(*) = 1;
    if v_member is not null then
      v_link := 'email';
    end if;
  end if;

  -- The stay-in-touch list, for a confirmed email. "No thanks" is never redone, and an add only for a new email (the
  -- list entry this added for the old one goes: the entry follows the person's address). 'already' and 'unsubscribed'
  -- are looked at again each sign-in, so a member row removed since, or a lifted unsubscribe, doesn't leave them out.
  if v_person.email is not null and v_person.email_confirmed
     and v_person.newsletter is distinct from 'declined'
     and (v_person.newsletter is distinct from 'added' or v_person.newsletter_email is distinct from v_person.email) then
    perform pg_advisory_xact_lock(hashtext('techne_newsletter:' || v_person.email));
    v_decided := true;
    if v_person.newsletter = 'added' and v_person.interest_id is not null then
      delete from interests i where i.id = v_person.interest_id and i.source_path = 'techne';
      v_person.interest_id := null;
    end if;
    if exists (select 1 from email_unsubscribes u where lower(trim(u.email)) = v_person.email) then
      v_person.newsletter := 'unsubscribed';
    elsif exists (select 1 from interests i where lower(trim(i.email)) = v_person.email)
       -- "already there": the newsletter reaches this address now (lib/newsletter.ts: interests, and members not disabled)
       or exists (select 1 from members m where lower(trim(m.email)) = v_person.email and not m.disabled) then
      v_person.newsletter := 'already';
    else
      insert into interests (email, name, source_path, member_id)
        values (v_person.email, v_person.name, 'techne', v_member)
        returning id into v_interest;
      v_person.newsletter := 'added';
      v_added := true;
    end if;
  end if;

  update techne_people t set
    member_id = v_member,
    member_link = v_link,
    newsletter = v_person.newsletter,
    newsletter_email = case when v_decided then v_person.email else t.newsletter_email end,
    interest_id = case when v_decided then v_interest else t.interest_id end
   where t.did = p_did;

  return query select v_member, v_link, v_added;
end;
$$;

-- "No thanks" after sign-in: the list row this sign-in added goes (nothing else), and the person is not added again.
-- Answers whether anything changed.
create function decline_techne_newsletter(p_did text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_person techne_people%rowtype;
begin
  select * into v_person from techne_people t where t.did = p_did for update;
  if not found or v_person.newsletter = 'declined' then
    return false;
  end if;
  if v_person.newsletter = 'added' and v_person.interest_id is not null then
    delete from interests i where i.id = v_person.interest_id and i.source_path = 'techne';
  end if;
  update techne_people t set newsletter = 'declined', interest_id = null where t.did = p_did;
  return true;
end;
$$;

revoke all on function record_techne_sign_in(text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function record_techne_sign_in(text, text, text, text, boolean) to service_role;
revoke all on function decline_techne_newsletter(text) from public, anon, authenticated;
grant execute on function decline_techne_newsletter(text) to service_role;
