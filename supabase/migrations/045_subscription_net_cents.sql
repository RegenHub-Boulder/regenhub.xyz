-- Migration 045: subscriptions.net_cents — what Stripe is actually charging
-- after coupons / promotion codes, as opposed to monthly_cents (list price).
--
-- monthly_cents stays the Price unit_amount. Checkout promo codes
-- (allow_promotion_codes) never landed in monthly_cents or discount_*, so
-- admin billing MRR was list, not cash. net_cents is written from the
-- expanded subscription.discounts on every Stripe webhook upsert, and can
-- be backfilled via POST /api/admin/billing/refresh-nets.
--
-- Null means not yet synced — readers fall back to monthly_cents.

alter table subscriptions
  add column if not exists net_cents integer;

comment on column subscriptions.net_cents is
  'Recurring amount Stripe is charging this period after currently-active coupons/promo codes. Null = not yet synced from Stripe; treat as monthly_cents (list).';
