-- Migration 064: the one door. "Sign in with Techne" also starts the portal session.
--
-- The server starts a member's Supabase session from a verified Techne proof (an atproto service-auth
-- JWT, apps/web/src/lib/techne/serviceAuth.ts) only for the DID in members.did. A Techne account that
-- isn't linked yet links once, proved by an email link sent to the member's own email (never an email the
-- Techne account claims), and only from the same Techne account that asked.
--
--   techne_used_proofs     each proof is used once (sha-256 of the token), kept until it expires
--   techne_link_requests   one row per "link my membership" ask: rate limit, single-use emailed code
--   use_techne_proof       spend a proof (false = already used)
--   begin_techne_link      rate-limit (3 asks an hour per DID; 10 link emails an hour per member) and record an ask
--   confirm_techne_link    the emailed code + the same DID: write members.did, audit, in one transaction
--
-- Server-only: RLS on, no policies, functions granted to service_role alone. Additive.
-- Reverse: drop function confirm_techne_link(text, text); drop function begin_techne_link(text, text, text);
--   drop function use_techne_proof(text, timestamptz); drop table techne_link_requests; drop table techne_used_proofs;
set local lock_timeout = '5s';

create table techne_used_proofs (
  token_key  text primary key,
  expires_at timestamptz not null
);
alter table techne_used_proofs enable row level security;
revoke all on techne_used_proofs from public, anon, authenticated;

create table techne_link_requests (
  id          bigserial primary key,
  -- sha-256 of the emailed code; the code itself is never stored
  code_hash   text not null unique,
  did         text not null,
  -- null when no member has the email typed (nothing is sent; the row still counts for the rate limit)
  member_id   integer references members(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 minutes',
  used_at     timestamptz
);
create index techne_link_requests_did_idx on techne_link_requests (did, created_at desc);
create index techne_link_requests_member_idx on techne_link_requests (member_id, created_at desc);
alter table techne_link_requests enable row level security;
revoke all on techne_link_requests from public, anon, authenticated;

comment on column members.did is
  'atproto DID (Techne). Server-written only: by the Techne link (confirm_techne_link, after an email link to this member''s email) or the old regenOS lane. Not self-editable. Signing in with Techne as this DID starts this member''s portal session.';

-- Spend a proof once. Clears expired ones as it goes.
create function use_techne_proof(p_key text, p_expires_at timestamptz) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  delete from techne_used_proofs where expires_at < now() - interval '5 minutes';
  insert into techne_used_proofs (token_key, expires_at) values (p_key, p_expires_at)
    on conflict (token_key) do nothing;
  return found;
end;
$$;

-- Record a link ask. status:
--   'sent'           email the code to member_email
--   'no_member'      no member has that email (send nothing)
--   'linked'         this DID is already this member's (nothing to do)
--   'taken'          the member has another DID, or this DID is another member's (send nothing; staff sort it out)
--   'rate_limited'   3 asks an hour from this DID (says nothing about the email, so the route may answer 429)
--   'quiet'          this member already had 10 link emails this hour (send nothing; the route answers as for
--                    'sent', so the limit doesn't tell anyone the email is a member's)
create function begin_techne_link(p_did text, p_email text, p_code_hash text)
returns table (status text, member_id integer, member_email text, member_name text)
language plpgsql security definer set search_path = public as $$
declare
  m members%rowtype;
begin
  if p_did is null or p_did !~ '^did:(plc|web):' then raise exception 'a link needs a DID'; end if;
  perform pg_advisory_xact_lock(hashtext('techne_link:' || p_did));
  if (select count(*) from techne_link_requests r
        where r.did = p_did and r.created_at > now() - interval '1 hour') >= 3 then
    return query select 'rate_limited', null::integer, null::text, null::text;
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
  insert into techne_link_requests (code_hash, did, member_id) values (p_code_hash, p_did, m.id);
  if m.did is not null or exists (select 1 from members o where o.did = p_did) then
    return query select 'taken', null::integer, null::text, null::text;
    return;
  end if;
  return query select 'sent', m.id, m.email, m.name;
end;
$$;

-- Redeem an emailed code. Only the DID that asked may redeem it (so a member who clicks a link someone else
-- asked for links nothing). status: 'linked' (members.did written, or already this DID), 'invalid', 'used',
-- 'expired', 'wrong_account' (code not spent), 'taken'.
create function confirm_techne_link(p_code_hash text, p_did text)
returns table (status text, member_id integer, member_email text)
language plpgsql security definer set search_path = public as $$
declare
  r techne_link_requests%rowtype;
  m members%rowtype;
begin
  select * into r from techne_link_requests where code_hash = p_code_hash for update;
  if not found or r.member_id is null then
    return query select 'invalid', null::integer, null::text; return;
  end if;
  if r.did <> p_did then return query select 'wrong_account', null::integer, null::text; return; end if;
  if r.used_at is not null then return query select 'used', null::integer, null::text; return; end if;
  if r.expires_at < now() then return query select 'expired', null::integer, null::text; return; end if;
  select * into m from members where id = r.member_id for update;
  if not found then return query select 'invalid', null::integer, null::text; return; end if;
  if m.did = p_did then
    update techne_link_requests set used_at = now() where id = r.id;
    return query select 'linked', m.id, m.email; return;
  end if;
  if m.did is not null or exists (select 1 from members o where o.did = p_did) then
    return query select 'taken', null::integer, null::text; return;
  end if;
  update members set did = p_did where id = m.id;
  update techne_link_requests set used_at = now() where id = r.id;
  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
    values (m.id, 'techne_did_linked', 'members', m.id::text,
            jsonb_build_object('did', p_did, 'link_request_id', r.id, 'proof', 'email link to the member email'));
  return query select 'linked', m.id, m.email;
end;
$$;

revoke all on function use_techne_proof(text, timestamptz) from public, anon, authenticated;
grant execute on function use_techne_proof(text, timestamptz) to service_role;
revoke all on function begin_techne_link(text, text, text) from public, anon, authenticated;
grant execute on function begin_techne_link(text, text, text) to service_role;
revoke all on function confirm_techne_link(text, text) from public, anon, authenticated;
grant execute on function confirm_techne_link(text, text) to service_role;
