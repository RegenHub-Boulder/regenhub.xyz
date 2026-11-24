-- migration 072: one way to join (T-482 round 5).
--
-- Apply, one member vouches, one approval, then the person picks any day plan themselves. Desks are an upgrade a
-- steward turns on for a member. This replaces the two approvals (approved_for_daily, "daily"; approved_for_full,
-- "full"):
--   members.member_approved (+ _at, _by)  the one approval: may buy any day plan ($30/$50/$100)
--   members.desk_access     (+ _at, _by)  a steward (canApproveDesks) turned desks on: may buy a desk
--   members.desk_asked_at                 the member asked about a desk from the portal
--   applications.known_by_member_id       "Who here knows you?" (null = nobody yet)
--   applications.how_found                "How did you find us?"
--   applications.vouched_by / vouched_at  the one member who vouched (needed before approval)
--   applications.chat_message_id          the members' chat card, so the site can update it
--   applications.chat_reposted_at, free_day_claims.chat_reposted_at   the one "still waiting" re-post at 12 h
--
-- Backfill: member_approved = approved_for_daily or approved_for_full; desk_access = approved_for_full, so everyone
-- approved before keeps what they had. For one release the old flags stay and a trigger keeps old and new equal
-- whichever side writes (an old bot still running during the deploy, or this code), so either code can run against
-- this schema. A follow-up migration drops approved_for_* and the trigger once nothing reads them.
--
-- vouch_for_application and approve_application are the one code path for the members' chat (bot) and the site
-- (portal, People -> Applications): both call them through @regenhub/shared (packages/shared/src/joining.ts).
--
-- Additive. The code works before this runs: it reads the old flags, and vouching/approving answer that they wait
-- for 072.
-- Reverse: drop function approve_application(integer, integer, text); drop function vouch_for_application(integer, integer);
--          drop function member_can_vouch(integer); drop function member_can_approve(integer);
--          drop trigger members_approval_mirror on members; drop function mirror_member_approval();
--          alter table free_day_claims drop column chat_reposted_at;
--          alter table applications drop column how_found, drop column known_by_member_id, drop column vouched_by,
--            drop column vouched_at, drop column chat_message_id, drop column chat_reposted_at;
--          alter table members drop column member_approved, drop column member_approved_at, drop column member_approved_by,
--            drop column desk_access, drop column desk_access_at, drop column desk_access_by, drop column desk_asked_at;
set local lock_timeout = '5s';

alter table members
  add column member_approved boolean not null default false,
  add column member_approved_at timestamptz,
  add column member_approved_by integer references members(id) on delete set null,
  add column desk_access boolean not null default false,
  add column desk_access_at timestamptz,
  add column desk_access_by integer references members(id) on delete set null,
  add column desk_asked_at timestamptz;

update members set
  member_approved = coalesce(approved_for_daily, false) or coalesce(approved_for_full, false),
  member_approved_at = case when approved_for_daily or approved_for_full
                            then coalesce(approved_for_daily_at, approved_for_full_at) end,
  member_approved_by = case when approved_for_daily or approved_for_full
                            then coalesce(approved_for_daily_by, approved_for_full_by) end,
  desk_access = coalesce(approved_for_full, false),
  desk_access_at = case when approved_for_full then approved_for_full_at end,
  desk_access_by = case when approved_for_full then approved_for_full_by end
where approved_for_daily or approved_for_full;

-- One release: whichever pair a writer sets, the other follows. New names win when both change in one statement.
create or replace function mirror_member_approval()
returns trigger language plpgsql set search_path = public as $$
declare
  new_side boolean := tg_op = 'INSERT'
    or new.member_approved is distinct from old.member_approved
    or new.desk_access is distinct from old.desk_access;
  old_side boolean := tg_op = 'UPDATE' and (
    new.approved_for_daily is distinct from old.approved_for_daily
    or new.approved_for_full is distinct from old.approved_for_full);
begin
  if old_side and not (tg_op = 'UPDATE' and (new.member_approved is distinct from old.member_approved
                                             or new.desk_access is distinct from old.desk_access)) then
    new.member_approved := coalesce(new.approved_for_daily, false) or coalesce(new.approved_for_full, false);
    new.member_approved_at := case when new.member_approved
      then coalesce(new.member_approved_at, new.approved_for_daily_at, new.approved_for_full_at, now()) end;
    new.member_approved_by := case when new.member_approved
      then coalesce(new.member_approved_by, new.approved_for_daily_by, new.approved_for_full_by) end;
    new.desk_access := coalesce(new.approved_for_full, false);
    new.desk_access_at := case when new.desk_access then coalesce(new.desk_access_at, new.approved_for_full_at, now()) end;
    new.desk_access_by := case when new.desk_access then coalesce(new.desk_access_by, new.approved_for_full_by) end;
  elsif new_side then
    if tg_op = 'INSERT' and (coalesce(new.approved_for_daily, false) or coalesce(new.approved_for_full, false))
       and not new.member_approved and not new.desk_access then
      -- An insert by old code that set only the old flags.
      new.member_approved := true;
      new.desk_access := coalesce(new.approved_for_full, false);
    end if;
    new.approved_for_daily := new.member_approved or new.desk_access;
    new.approved_for_daily_at := case when new.approved_for_daily then coalesce(new.member_approved_at, now()) end;
    new.approved_for_daily_by := case when new.approved_for_daily then new.member_approved_by end;
    new.approved_for_full := new.desk_access;
    new.approved_for_full_at := case when new.desk_access then coalesce(new.desk_access_at, now()) end;
    new.approved_for_full_by := case when new.desk_access then new.desk_access_by end;
  end if;
  return new;
end;
$$;

create trigger members_approval_mirror
  before insert or update on members
  for each row execute function mirror_member_approval();

alter table applications
  add column how_found text,
  add column known_by_member_id integer references members(id) on delete set null,
  add column vouched_by integer references members(id) on delete set null,
  add column vouched_at timestamptz,
  add column chat_message_id bigint,
  add column chat_reposted_at timestamptz;

alter table free_day_claims add column chat_reposted_at timestamptz;

-- Who may vouch: a member in standing (lib/memberStanding.ts: a hub friend or desk, or an active/trialing plan at
-- $30+ on either rail), a co-op owner, or a site admin. Disabled rows never.
create or replace function member_can_vouch(p_member integer)
returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1 from members m
    where m.id = p_member and not coalesce(m.disabled, false)
      and (m.member_type in ('hub_friend', 'hot_desk', 'cold_desk')
           or coalesce(m.is_coop_member, false)
           or coalesce(m.is_admin, false)
           or exists (select 1 from subscriptions s
                      where s.member_id = m.id and s.status in ('active', 'trialing') and s.monthly_cents >= 3000)));
$$;

-- Who may approve an application: a site admin (the stewards who answer the members' chat). Desks are a separate,
-- narrower check in the app (canApproveDesks).
create or replace function member_can_approve(p_member integer)
returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from members m where m.id = p_member and m.is_admin and not coalesce(m.disabled, false));
$$;

-- One member vouches for a pending application. Refusals raise with a short code the app turns into words:
--   not_found, not_pending, not_a_member, own_application. A second vouch keeps the first and answers 'already'.
create or replace function vouch_for_application(p_application integer, p_member integer)
returns text language plpgsql security definer set search_path = public as $$
declare
  app applications%rowtype;
  voucher members%rowtype;
begin
  select * into app from applications where id = p_application for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if app.status <> 'pending' then raise exception 'not_pending' using errcode = 'P0001'; end if;
  if not member_can_vouch(p_member) then raise exception 'not_a_member' using errcode = 'P0001'; end if;
  select * into voucher from members where id = p_member;
  if lower(coalesce(voucher.email, '')) = lower(app.email)
     or (voucher.supabase_user_id is not null and voucher.supabase_user_id = app.supabase_user_id) then
    raise exception 'own_application' using errcode = 'P0001';
  end if;
  if app.vouched_by is not null then return 'already'; end if;
  update applications set vouched_by = p_member, vouched_at = now(), updated_at = now() where id = p_application;
  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
  values (p_member, 'application_vouched', 'applications', p_application::text,
          jsonb_build_object('named', app.known_by_member_id = p_member));
  return 'vouched';
end;
$$;

-- The one approval. Needs a vouch and an approver who may approve. Finds the applicant's member row by email (the
-- exact lowercase row first) or makes a day-pass row, turns member_approved on, marks the application approved and
-- writes the audit row, in one transaction. Refusals: not_found, not_pending, no_vouch, not_allowed.
-- Returns {member_id, name, email, already}; already = it was approved before this call (nothing changed).
create or replace function approve_application(p_application integer, p_approver integer, p_via text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  app applications%rowtype;
  v_member integer;
  v_handle text;
begin
  select * into app from applications where id = p_application for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if app.status = 'approved' then
    select id into v_member from members where lower(email) = lower(app.email)
      order by (email = lower(app.email)) desc, id limit 1;
    return jsonb_build_object('member_id', v_member, 'name', app.name, 'email', app.email, 'already', true);
  end if;
  if app.status <> 'pending' then raise exception 'not_pending' using errcode = 'P0001'; end if;
  if app.vouched_by is null then raise exception 'no_vouch' using errcode = 'P0001'; end if;
  if not member_can_approve(p_approver) then raise exception 'not_allowed' using errcode = 'P0001'; end if;

  select id into v_member from members where lower(email) = lower(app.email)
    order by (email = lower(app.email)) desc, id limit 1 for update;
  v_handle := nullif(trim(regexp_replace(coalesce(app.telegram, ''), '^@+', '')), '');
  if v_member is null then
    begin
      insert into members (name, email, member_type, supabase_user_id, telegram_username)
      values (app.name, lower(app.email), 'day_pass', app.supabase_user_id, v_handle)
      returning id into v_member;
    exception when unique_violation then
      -- The handle (or the sign-in) is already on another row: join without it rather than fail the approval.
      insert into members (name, email, member_type)
      values (app.name, lower(app.email), 'day_pass')
      returning id into v_member;
    end;
  end if;

  update members set member_approved = true, member_approved_at = now(), member_approved_by = p_approver
    where id = v_member;
  update applications set status = 'approved', approved_by = p_approver, rejected_by = null, rejected_at = null,
    updated_at = now() where id = p_application;
  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
  values (p_approver, 'membership_approved', 'members', v_member::text,
          jsonb_build_object('application_id', p_application, 'vouched_by', app.vouched_by, 'via', p_via));
  return jsonb_build_object('member_id', v_member, 'name', app.name, 'email', app.email, 'already', false);
end;
$$;

revoke all on function vouch_for_application(integer, integer) from public, anon, authenticated;
revoke all on function approve_application(integer, integer, text) from public, anon, authenticated;
grant execute on function vouch_for_application(integer, integer) to service_role;
grant execute on function approve_application(integer, integer, text) to service_role;
