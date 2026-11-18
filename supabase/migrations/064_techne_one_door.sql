-- Migration 064: the one door. "Sign in with Techne" also starts the portal session.
--
-- regenhub.xyz is a confidential atproto OAuth client on the server (apps/web/src/lib/techne/oauth/). The
-- server exchanges the code, checks the account's DID and that the token's issuer is that DID's own PDS, and
-- only then starts the portal (Supabase) session, for the member whose members.did is that DID. A Techne
-- account that isn't linked yet links once, proved by an email link sent to the member's own email (never an
-- email the Techne account claims), and only from the same Techne account that asked.
--
--   techne_oauth_states    the OAuth library's pending sign-ins (PKCE verifier, DPoP key), single use, 1 hour
--   techne_oauth_sessions  the OAuth library's sessions, one per DID (tokens + DPoP key). Secret: server only
--   techne_web_sessions    this site's sign-in cookie → DID (sha-256 of the cookie; the cookie itself is never stored)
--   techne_rate_hits       per-IP limits on the door's routes (sha-256 of the IP)
--   techne_link_requests   one row per "link my membership" ask: rate limit, single-use emailed code
--   techne_rate_ok         count a hit, answer whether it is within the limit
--   prune_techne_sessions  drop expired web sessions, and OAuth sessions no browser has used for a day
--   begin_techne_link      rate-limit (3 asks an hour per DID; 50 link emails an hour in all; 10 an hour per
--                          member) and record an ask
--   confirm_techne_link    the emailed code + the same DID: write members.did, audit, in one transaction
--   unlink_techne          clear members.did, end that account's sign-ins here and the member's portal sessions,
--                          audit, in one transaction
--
-- Server-only: RLS on, no policies, functions granted to service_role alone. Additive.
-- Reverse: drop function unlink_techne(integer, integer, uuid); drop function confirm_techne_link(text, text);
--   drop function begin_techne_link(text, text, text); drop function techne_rate_ok(text, integer, integer);
--   drop function prune_techne_sessions();
--   drop table techne_link_requests, techne_rate_hits, techne_web_sessions, techne_oauth_sessions, techne_oauth_states;
set local lock_timeout = '5s';

create table techne_oauth_states (
  key        text primary key,
  value      jsonb not null,
  created_at timestamptz not null default now()
);
alter table techne_oauth_states enable row level security;
revoke all on techne_oauth_states from public, anon, authenticated;

create table techne_oauth_sessions (
  did        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table techne_oauth_sessions enable row level security;
revoke all on techne_oauth_sessions from public, anon, authenticated;

create table techne_web_sessions (
  id_hash    text primary key,
  did        text not null,
  -- shown only ("Signed in as @handle"), from the DID document at sign-in; never used to pick a member
  handle     text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index techne_web_sessions_did_idx on techne_web_sessions (did);
create index techne_web_sessions_expires_idx on techne_web_sessions (expires_at);
alter table techne_web_sessions enable row level security;
revoke all on techne_web_sessions from public, anon, authenticated;

create table techne_rate_hits (
  bucket text not null,
  at     timestamptz not null default now()
);
create index techne_rate_hits_idx on techne_rate_hits (bucket, at desc);
create index techne_rate_hits_at_idx on techne_rate_hits (at);
alter table techne_rate_hits enable row level security;
revoke all on techne_rate_hits from public, anon, authenticated;

create table techne_link_requests (
  id          bigserial primary key,
  -- sha-256 of the emailed code; the code itself is never stored
  code_hash   text not null unique,
  did         text not null,
  -- null when no member has the email typed (nothing is sent; the row still counts for the rate limit)
  member_id   integer references members(id) on delete cascade,
  -- an email went out for this ask (counts toward the hourly cap on all link emails)
  emailed     boolean not null default false,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 minutes',
  used_at     timestamptz
);
create index techne_link_requests_did_idx on techne_link_requests (did, created_at desc);
create index techne_link_requests_member_idx on techne_link_requests (member_id, created_at desc);
create index techne_link_requests_created_idx on techne_link_requests (created_at);
alter table techne_link_requests enable row level security;
revoke all on techne_link_requests from public, anon, authenticated;

comment on column members.did is
  'atproto DID (Techne). Server-written only: by the Techne link (confirm_techne_link, after an email link to this member''s email), cleared by unlink_techne, or the old regenOS lane. Not self-editable. Signing in with Techne (this site''s own OAuth client) as this DID starts this member''s portal session.';

-- Count one hit in `p_bucket` and answer whether it is within `p_limit` per `p_window_seconds`. Clears old hits.
create function techne_rate_ok(p_bucket text, p_limit integer, p_window_seconds integer) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('techne_rate:' || p_bucket));
  delete from techne_rate_hits where at < now() - interval '1 day';
  if (select count(*) from techne_rate_hits
        where bucket = p_bucket and at > now() - make_interval(secs => p_window_seconds)) >= p_limit then
    return false;
  end if;
  insert into techne_rate_hits (bucket) values (p_bucket);
  return true;
end;
$$;

-- Expired web sessions go; so does an OAuth session (tokens, DPoP key) that no live web session uses and that
-- hasn't been refreshed for a day (a fresh one is written just before its web session, so it is never caught).
create function prune_techne_sessions() returns void
language sql security definer set search_path = public as $$
  delete from techne_web_sessions where expires_at < now();
  delete from techne_oauth_sessions o
    where o.updated_at < now() - interval '1 day'
      and not exists (select 1 from techne_web_sessions w where w.did = o.did);
$$;

-- Record a link ask. status:
--   'sent'           email the code to member_email
--   'no_member'      no member has that email (send nothing)
--   'linked'         this DID is already this member's (nothing to do)
--   'taken'          the member has another DID, or this DID is another member's (send nothing; staff sort it out)
--   'rate_limited'   3 asks an hour from this DID (says nothing about the email, so the route may answer 429)
--   'busy'           50 link emails went out this hour in all (checked before the email is looked up, so it says
--                    nothing about it; the route answers 429 and the person can use an email link instead)
--   'quiet'          this member already had 10 link emails this hour (send nothing; the route answers as for
--                    'sent', so the limit doesn't tell anyone the email is a member's)
-- Only did:plc (Techne accounts are did:plc; a did:web costs nothing to make).
create function begin_techne_link(p_did text, p_email text, p_code_hash text)
returns table (status text, member_id integer, member_email text, member_name text)
language plpgsql security definer set search_path = public as $$
declare
  m members%rowtype;
begin
  if p_did is null or p_did !~ '^did:plc:[a-z0-9]{1,64}$' then raise exception 'a link needs a did:plc'; end if;
  perform pg_advisory_xact_lock(hashtext('techne_link:' || p_did));
  delete from techne_link_requests r where r.created_at < now() - interval '1 day';
  if (select count(*) from techne_link_requests r
        where r.did = p_did and r.created_at > now() - interval '1 hour') >= 3 then
    return query select 'rate_limited', null::integer, null::text, null::text;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('techne_link_emails'));
  if (select count(*) from techne_link_requests r
        where r.emailed and r.created_at > now() - interval '1 hour') >= 50 then
    return query select 'busy', null::integer, null::text, null::text;
    return;
  end if;
  select * into m from members where lower(email) = lower(trim(p_email)) for update;
  if not found then
    insert into techne_link_requests (code_hash, did) values (p_code_hash, p_did);
    return query select 'no_member', null::integer, null::text, null::text;
    return;
  end if;
  if m.did = p_did then
    return query select 'linked', m.id, m.email, m.name;
    return;
  end if;
  if (select count(*) from techne_link_requests r
        where r.member_id = m.id and r.created_at > now() - interval '1 hour') >= 10 then
    insert into techne_link_requests (code_hash, did) values (p_code_hash, p_did);
    return query select 'quiet', null::integer, null::text, null::text;
    return;
  end if;
  if m.did is not null or exists (select 1 from members o where o.did = p_did) then
    insert into techne_link_requests (code_hash, did, member_id) values (p_code_hash, p_did, m.id);
    return query select 'taken', null::integer, null::text, null::text;
    return;
  end if;
  insert into techne_link_requests (code_hash, did, member_id, emailed) values (p_code_hash, p_did, m.id, true);
  return query select 'sent', m.id, m.email, m.name;
end;
$$;

-- Redeem an emailed code. Only the DID that asked may redeem it (so a member who clicks a link someone else
-- asked for links nothing). status: 'linked' (members.did written, or already this DID), 'invalid', 'used',
-- 'expired', 'wrong_account' (code not spent), 'taken'. `newly` says whether this call wrote the link (the route
-- emails the member then).
create function confirm_techne_link(p_code_hash text, p_did text)
returns table (status text, member_id integer, member_email text, member_name text, newly boolean)
language plpgsql security definer set search_path = public as $$
declare
  r techne_link_requests%rowtype;
  m members%rowtype;
begin
  select * into r from techne_link_requests where code_hash = p_code_hash for update;
  if not found or r.member_id is null then
    return query select 'invalid', null::integer, null::text, null::text, false; return;
  end if;
  if r.did <> p_did then return query select 'wrong_account', null::integer, null::text, null::text, false; return; end if;
  if r.used_at is not null then return query select 'used', null::integer, null::text, null::text, false; return; end if;
  if r.expires_at < now() then return query select 'expired', null::integer, null::text, null::text, false; return; end if;
  select * into m from members where id = r.member_id for update;
  if not found then return query select 'invalid', null::integer, null::text, null::text, false; return; end if;
  if m.did = p_did then
    update techne_link_requests set used_at = now() where id = r.id;
    return query select 'linked', m.id, m.email, m.name, false; return;
  end if;
  if m.did is not null or exists (select 1 from members o where o.did = p_did) then
    return query select 'taken', null::integer, null::text, null::text, false; return;
  end if;
  update members set did = p_did where id = m.id;
  update techne_link_requests set used_at = now() where id = r.id;
  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
    values (m.id, 'techne_did_linked', 'members', m.id::text,
            jsonb_build_object('did', p_did, 'link_request_id', r.id, 'proof', 'email link to the member email'));
  return query select 'linked', m.id, m.email, m.name, true;
end;
$$;

-- Unlink a member's Techne account: clear members.did, end every sign-in here with that account (its web sessions
-- and the server-held OAuth session), end the member's portal sessions except `p_keep_session` (the member's own
-- current one, when they unlink themselves), and audit `techne_did_unlinked` naming who did it. Answers the DID
-- that was unlinked (null: nothing was linked).
create function unlink_techne(p_member_id integer, p_actor_member_id integer, p_keep_session uuid default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  m members%rowtype;
begin
  select * into m from members where id = p_member_id for update;
  if not found or m.did is null then return null; end if;
  update members set did = null where id = m.id;
  delete from techne_web_sessions where did = m.did;
  delete from techne_oauth_sessions where did = m.did;
  -- Portal sessions: GoTrue's own table, when there is one (not in the test databases).
  if m.supabase_user_id is not null and to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where user_id = $1 and ($2::uuid is null or id <> $2)'
      using m.supabase_user_id, p_keep_session;
  end if;
  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
    values (p_actor_member_id, 'techne_did_unlinked', 'members', m.id::text,
            jsonb_build_object('did', m.did, 'by', case when p_actor_member_id = m.id then 'member' else 'admin' end));
  return m.did;
end;
$$;

revoke all on function prune_techne_sessions() from public, anon, authenticated;
grant execute on function prune_techne_sessions() to service_role;
revoke all on function techne_rate_ok(text, integer, integer) from public, anon, authenticated;
grant execute on function techne_rate_ok(text, integer, integer) to service_role;
revoke all on function begin_techne_link(text, text, text) from public, anon, authenticated;
grant execute on function begin_techne_link(text, text, text) to service_role;
revoke all on function confirm_techne_link(text, text) from public, anon, authenticated;
grant execute on function confirm_techne_link(text, text) to service_role;
revoke all on function unlink_techne(integer, integer, uuid) from public, anon, authenticated;
grant execute on function unlink_techne(integer, integer, uuid) to service_role;
