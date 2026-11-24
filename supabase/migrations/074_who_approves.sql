-- migration 074: who may approve (T-482, Aaron 11-24: "any member in the core group (telegram) can approve. I think
-- on the website, they need to be a co-op member.")
--
-- Two doors, one approval each:
--   The members' chat (the bot's TELEGRAM_GROUP_CHAT_ID): anyone in that chat may vouch for an application, approve
--     one, or approve a free day. Being in that private group is the trust; the bot checks the tap came from that
--     exact chat before it calls the chat_* functions below. The tapper is recorded by their member row when their
--     Telegram is linked, else by their Telegram id and username.
--   The site (People -> Applications / Free days): a co-op member (members.is_coop_member), not disabled. The app's
--     one rule is lib/approval.ts canApproveOnSite; member_can_approve below is the same rule in SQL.
-- Desks are unchanged (site admin + ops admin, in the app: canApproveDesks).
--
-- New columns:
--   applications.vouched_by_telegram_id / vouched_by_telegram     an unlinked chat member who vouched
--   applications.approved_by_telegram_id / approved_by_telegram   an unlinked chat member who approved
--   free_day_claims.approved_by_member_id                         the approver's member row (site, or linked chat)
--   free_day_claims.approved_by_telegram_id                       the approver's Telegram id (chat)
--   (free_day_claims.approved_by, text, keeps the words: a name, or @username)
--
-- Changed functions:
--   member_can_approve(member)     site admin -> co-op member
--   vouch_for_application          the site's vouch: member_can_vouch -> member_can_approve (co-op member)
--   approve_application            the site's approval: now also refuses the applicant themselves
-- New functions: chat_vouch_for_application, chat_approve_application, approve_free_day, chat_approve_free_day (and
-- the shared bodies approve_application_core, free_day_approve_core, application_is_own; service role only).
-- member_can_vouch stays as it was: it is who an applicant may name as knowing them (lib/vouchers.ts mirrors it).
--
-- Additive. The code works before this runs: the chat falls back to 072's functions for a linked member (072's rule:
-- a site admin approves) and tells an unlinked tapper it waits for 074; free days fall back to the old update.
-- Reverse: drop function chat_approve_free_day(integer, bigint, text, integer);
--          drop function approve_free_day(integer, integer);
--          drop function free_day_approve_core(integer, integer, bigint, text, text);
--          drop function chat_approve_application(integer, bigint, text, integer);
--          drop function chat_vouch_for_application(integer, bigint, text, integer);
--          drop function approve_application_core(integer, integer, bigint, text, text, boolean);
--          drop function application_is_own(integer, integer, text);
--          then re-run 072's definitions of member_can_approve, vouch_for_application and approve_application;
--          alter table free_day_claims drop column approved_by_member_id, drop column approved_by_telegram_id;
--          alter table applications drop column vouched_by_telegram_id, drop column vouched_by_telegram,
--            drop column approved_by_telegram_id, drop column approved_by_telegram;
set local lock_timeout = '5s';

alter table applications
  add column vouched_by_telegram_id bigint,
  add column vouched_by_telegram text,
  add column approved_by_telegram_id bigint,
  add column approved_by_telegram text;

alter table free_day_claims
  add column approved_by_member_id integer references members(id) on delete set null,
  add column approved_by_telegram_id bigint;

-- The site's rule (lib/approval.ts canApproveOnSite): a co-op member, not disabled.
create or replace function member_can_approve(p_member integer)
returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from members m
                 where m.id = p_member and coalesce(m.is_coop_member, false) and not coalesce(m.disabled, false));
$$;

-- Is this the applicant acting on their own application? By the member row (email or sign-in), or, for a chat tap,
-- by the Telegram handle they gave on the application.
create or replace function application_is_own(p_application integer, p_member integer, p_telegram_username text)
returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1 from applications a
    where a.id = p_application and (
      exists (select 1 from members m where m.id = p_member
              and (lower(coalesce(m.email, '')) = lower(a.email)
                   or (m.supabase_user_id is not null and m.supabase_user_id = a.supabase_user_id)))
      or (nullif(lower(trim(regexp_replace(coalesce(p_telegram_username, ''), '^@+', ''))), '') is not null
          and lower(trim(regexp_replace(coalesce(p_telegram_username, ''), '^@+', '')))
            = lower(trim(regexp_replace(coalesce(a.telegram, ''), '^@+', ''))))));
$$;

-- The site's vouch: a co-op member, never for themselves; the first vouch stays.
create or replace function vouch_for_application(p_application integer, p_member integer)
returns text language plpgsql security definer set search_path = public as $$
declare
  app applications%rowtype;
begin
  select * into app from applications where id = p_application for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if app.status <> 'pending' then raise exception 'not_pending' using errcode = 'P0001'; end if;
  if not member_can_approve(p_member) then raise exception 'not_coop' using errcode = 'P0001'; end if;
  if application_is_own(p_application, p_member, null) then raise exception 'own_application' using errcode = 'P0001'; end if;
  if app.vouched_by is not null or app.vouched_by_telegram_id is not null then return 'already'; end if;
  update applications set vouched_by = p_member, vouched_at = now(), updated_at = now() where id = p_application;
  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
  values (p_member, 'application_vouched', 'applications', p_application::text,
          jsonb_build_object('named', app.known_by_member_id = p_member, 'via', 'site'));
  return 'vouched';
end;
$$;

-- The chat's vouch: anyone in the members' chat (the bot checked the chat). p_member is their linked member row, or
-- null; then their Telegram id and username are what's recorded.
create or replace function chat_vouch_for_application(p_application integer, p_telegram_id bigint,
                                                      p_telegram_username text, p_member integer)
returns text language plpgsql security definer set search_path = public as $$
declare
  app applications%rowtype;
begin
  if p_telegram_id is null then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  select * into app from applications where id = p_application for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if app.status <> 'pending' then raise exception 'not_pending' using errcode = 'P0001'; end if;
  if exists (select 1 from members where id = p_member and coalesce(disabled, false)) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if application_is_own(p_application, p_member, p_telegram_username) then
    raise exception 'own_application' using errcode = 'P0001';
  end if;
  if app.vouched_by is not null or app.vouched_by_telegram_id is not null then return 'already'; end if;
  update applications set vouched_by = p_member, vouched_at = now(), updated_at = now(),
    vouched_by_telegram_id = p_telegram_id,
    vouched_by_telegram = nullif(trim(regexp_replace(coalesce(p_telegram_username, ''), '^@+', '')), '')
  where id = p_application;
  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
  values (p_member, 'application_vouched', 'applications', p_application::text,
          jsonb_build_object('named', app.known_by_member_id is not distinct from p_member and p_member is not null,
                             'via', 'chat', 'telegram_id', p_telegram_id, 'telegram_username', p_telegram_username));
  return 'vouched';
end;
$$;

-- The one approval's body, shared by the site and the chat. p_site = true checks the site's rule (co-op member);
-- the chat's check (the tap came from the members' chat) is the bot's. Refusals: not_found, not_pending, no_vouch,
-- not_allowed, own_application. Returns {member_id, name, email, already}.
create or replace function approve_application_core(p_application integer, p_approver integer, p_telegram_id bigint,
                                                     p_telegram_username text, p_via text, p_site boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  app applications%rowtype;
  v_member integer;
  v_handle text;
  v_tg text := nullif(trim(regexp_replace(coalesce(p_telegram_username, ''), '^@+', '')), '');
begin
  select * into app from applications where id = p_application for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if app.status = 'approved' then
    select id into v_member from members where lower(email) = lower(app.email)
      order by (email = lower(app.email)) desc, id limit 1;
    return jsonb_build_object('member_id', v_member, 'name', app.name, 'email', app.email, 'already', true);
  end if;
  if app.status <> 'pending' then raise exception 'not_pending' using errcode = 'P0001'; end if;
  if app.vouched_by is null and app.vouched_by_telegram_id is null then
    raise exception 'no_vouch' using errcode = 'P0001';
  end if;
  if p_site and not member_can_approve(p_approver) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if not p_site and (p_telegram_id is null
                     or exists (select 1 from members where id = p_approver and coalesce(disabled, false))) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if application_is_own(p_application, p_approver, case when p_site then null else v_tg end) then
    raise exception 'own_application' using errcode = 'P0001';
  end if;

  select id into v_member from members where lower(email) = lower(app.email)
    order by (email = lower(app.email)) desc, id limit 1 for update;
  v_handle := nullif(trim(regexp_replace(coalesce(app.telegram, ''), '^@+', '')), '');
  if v_member is null then
    begin
      insert into members (name, email, member_type, supabase_user_id, telegram_username)
      values (app.name, lower(app.email), 'day_pass', app.supabase_user_id, v_handle)
      returning id into v_member;
    exception when unique_violation then
      insert into members (name, email, member_type)
      values (app.name, lower(app.email), 'day_pass')
      returning id into v_member;
    end;
  end if;

  update members set member_approved = true, member_approved_at = now(), member_approved_by = p_approver
    where id = v_member;
  update applications set status = 'approved', approved_by = p_approver, rejected_by = null, rejected_at = null,
    approved_by_telegram_id = case when p_site then null else p_telegram_id end,
    approved_by_telegram = case when p_site then null else v_tg end,
    updated_at = now() where id = p_application;
  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
  values (p_approver, 'membership_approved', 'members', v_member::text,
          jsonb_build_object('application_id', p_application, 'vouched_by', app.vouched_by,
                             'vouched_by_telegram_id', app.vouched_by_telegram_id, 'via', p_via)
          || case when p_site then '{}'::jsonb
                  else jsonb_build_object('telegram_id', p_telegram_id, 'telegram_username', v_tg) end);
  return jsonb_build_object('member_id', v_member, 'name', app.name, 'email', app.email, 'already', false);
end;
$$;

-- The site's approval (072's signature, so 072's code keeps working): a co-op member.
create or replace function approve_application(p_application integer, p_approver integer, p_via text)
returns jsonb language sql security definer set search_path = public as $$
  select approve_application_core(p_application, p_approver, null, null, coalesce(p_via, 'site'), true);
$$;

-- The chat's approval: anyone in the members' chat (the bot checked the chat).
create or replace function chat_approve_application(p_application integer, p_telegram_id bigint,
                                                    p_telegram_username text, p_member integer)
returns jsonb language sql security definer set search_path = public as $$
  select approve_application_core(p_application, p_member, p_telegram_id, p_telegram_username, 'chat', false);
$$;

-- A free day, approved: pending -> reserved, who approved, and the audit row, in one transaction. Returns
-- {name, email, already}; already = it wasn't pending any more (nothing changed, no email to send).
create or replace function free_day_approve_core(p_claim integer, p_member integer, p_telegram_id bigint,
                                                 p_telegram_username text, p_via text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  claim free_day_claims%rowtype;
  v_tg text := nullif(trim(regexp_replace(coalesce(p_telegram_username, ''), '^@+', '')), '');
  v_words text;
begin
  select * into claim from free_day_claims where id = p_claim for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if claim.status <> 'pending' then
    return jsonb_build_object('name', claim.name, 'email', claim.email, 'already', true, 'status', claim.status);
  end if;
  select coalesce((select name from members where id = p_member), case when v_tg is not null then '@' || v_tg end)
    into v_words;
  update free_day_claims set status = 'reserved', approved_by = v_words, approved_by_member_id = p_member,
    approved_by_telegram_id = p_telegram_id where id = p_claim;
  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
  values (p_member, 'free_day_approved', 'free_day_claims', p_claim::text,
          jsonb_build_object('via', p_via)
          || case when p_telegram_id is null then '{}'::jsonb
                  else jsonb_build_object('telegram_id', p_telegram_id, 'telegram_username', v_tg) end);
  return jsonb_build_object('name', claim.name, 'email', claim.email, 'already', false, 'status', 'reserved');
end;
$$;

-- The site's free-day approval: a co-op member.
create or replace function approve_free_day(p_claim integer, p_member integer)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not member_can_approve(p_member) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  return free_day_approve_core(p_claim, p_member, null, null, 'site');
end;
$$;

-- The chat's free-day approval: anyone in the members' chat (the bot checked the chat).
create or replace function chat_approve_free_day(p_claim integer, p_telegram_id bigint, p_telegram_username text,
                                                 p_member integer)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_telegram_id is null or exists (select 1 from members where id = p_member and coalesce(disabled, false)) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  return free_day_approve_core(p_claim, p_member, p_telegram_id, p_telegram_username, 'chat');
end;
$$;

revoke all on function application_is_own(integer, integer, text) from public, anon, authenticated;
revoke all on function vouch_for_application(integer, integer) from public, anon, authenticated;
revoke all on function chat_vouch_for_application(integer, bigint, text, integer) from public, anon, authenticated;
revoke all on function approve_application_core(integer, integer, bigint, text, text, boolean) from public, anon, authenticated;
revoke all on function approve_application(integer, integer, text) from public, anon, authenticated;
revoke all on function chat_approve_application(integer, bigint, text, integer) from public, anon, authenticated;
revoke all on function free_day_approve_core(integer, integer, bigint, text, text) from public, anon, authenticated;
revoke all on function approve_free_day(integer, integer) from public, anon, authenticated;
revoke all on function chat_approve_free_day(integer, bigint, text, integer) from public, anon, authenticated;
grant execute on function vouch_for_application(integer, integer) to service_role;
grant execute on function chat_vouch_for_application(integer, bigint, text, integer) to service_role;
grant execute on function approve_application(integer, integer, text) to service_role;
grant execute on function chat_approve_application(integer, bigint, text, integer) to service_role;
grant execute on function approve_free_day(integer, integer) to service_role;
grant execute on function chat_approve_free_day(integer, bigint, text, integer) to service_role;
