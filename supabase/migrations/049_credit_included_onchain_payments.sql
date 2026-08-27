-- Credit exact native-USDC payments as soon as their successful OP receipt is
-- available. Membership payments are high-trust and the product should not
-- hold access behind OP's occasionally multi-minute safe-head lag.

alter table onchain_payments
  drop constraint onchain_payments_chain_status_check;

alter table onchain_payments
  add constraint onchain_payments_chain_status_check
  check (chain_status in ('included', 'safe', 'finalized', 'reorged'));

comment on column onchain_payments.chain_status is
  'included = exact successful receipt credited before OP safe/finalized; rechecked for canonical finalization by cron';
