-- Migration 012: Atomic day pass balance operations
-- Fixes race condition where concurrent reads/writes could produce
-- negative balances or lost updates (GitHub issue #28).

-- Atomic decrement: returns new balance, or -1 if insufficient balance / member not found
create or replace function decrement_day_pass_balance(p_member_id integer, p_amount integer default 1)
returns integer
language plpgsql
security definer
as $$
declare
  new_balance integer;
begin
  update members
  set day_passes_balance = day_passes_balance - p_amount
  where id = p_member_id
    and day_passes_balance >= p_amount
  returning day_passes_balance into new_balance;

  if new_balance is null then
    return -1;
  end if;

  return new_balance;
end;
$$;

-- Atomic increment: returns new balance, or -1 if member not found
create or replace function increment_day_pass_balance(p_member_id integer, p_amount integer)
returns integer
language plpgsql
security definer
as $$
declare
  new_balance integer;
begin
  update members
  set day_passes_balance = day_passes_balance + p_amount
  where id = p_member_id
  returning day_passes_balance into new_balance;

  if new_balance is null then
    return -1;
  end if;

  return new_balance;
end;
$$;

-- Safety net: prevent negative balances at the DB level
alter table members add constraint day_passes_balance_non_negative
  check (day_passes_balance >= 0);

-- Grant execute to all roles that need it
grant execute on function decrement_day_pass_balance(integer, integer) to anon, authenticated, service_role;
grant execute on function increment_day_pass_balance(integer, integer) to anon, authenticated, service_role;
