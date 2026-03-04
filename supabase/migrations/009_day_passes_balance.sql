-- Add day_passes_balance to members — single source of truth for pass count
alter table members add column day_passes_balance integer not null default 0;

-- Migrate existing balances from day_passes pools
update members m
set day_passes_balance = coalesce(
  (select sum(greatest(0, dp.allowed_uses - dp.used_count))
   from day_passes dp
   where dp.member_id = m.id),
  0
);
