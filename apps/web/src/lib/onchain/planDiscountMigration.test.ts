import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("freezes invoice prices/plans, coupon durations and idempotent generation in SQL", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table subscriptions(id integer primary key, member_id integer, payment_rail text, plan_key text, monthly_cents integer,
        status text, current_period_end timestamptz, net_cents integer, past_due_since timestamptz, access_disabled_at timestamptz);
      create table onchain_invoices(id bigserial primary key, subscription_id integer, member_id integer, period_start timestamptz,
        period_end timestamptz, base_amount_cents integer, discount_bps integer default 0, amount_cents integer, amount_usdc_micros bigint,
        status text default 'open', paid_at timestamptz, exception_reason text, unique(subscription_id, period_start));
      create table onchain_payments(id bigserial primary key, invoice_id bigint, member_id integer, chain_id bigint, tx_hash text,
        log_index integer, block_number bigint, block_hash text, from_address text, to_address text, token_contract text,
        amount_micros bigint, chain_status text, match_status text, credited_at timestamptz, raw_log jsonb);
      alter table onchain_invoices add column chain_id bigint default 10;
      insert into subscriptions(id, member_id, payment_rail, plan_key, monthly_cents) values(1, 7, 'onchain', 'cold_desk', 50000);
      insert into onchain_invoices(subscription_id,member_id,period_start,period_end,base_amount_cents,amount_cents,amount_usdc_micros)
        values(1,7,'2026-10-01','2026-11-01',50000,50000,500000000);`);
    await db.exec(await readFile(new URL("../../../../../supabase/migrations/057_onchain_plan_discounts.sql", import.meta.url), "utf8"));
    const row = async (sql: string) => (await db.query(sql)).rows[0] as Record<string, unknown>;
    // Migration itself does not rewrite a single existing invoice.
    expect(await row("select plan_key,amount_cents from onchain_invoices where id=1")).toEqual({ plan_key: null, amount_cents: 50000 });
    await db.exec("update subscriptions set plan_key='member_2day', monthly_cents=5000 where id=1");
    expect(await row("select plan_key,amount_cents from onchain_invoices where id=1")).toEqual({ plan_key: "cold_desk", amount_cents: 50000 });
    const issue = async (date: string, bps = 0) => db.exec(`insert into onchain_invoices(subscription_id,member_id,period_start,period_end,base_amount_cents,discount_bps,amount_cents,amount_usdc_micros)
      values(1,7,'${date}', '${date}'::timestamptz + interval '1 month',999,${bps},999,9990000) on conflict(subscription_id,period_start) do nothing`);
    const apply = async (duration: string, extra = '') => db.exec(`update subscriptions set onchain_coupon='{"code":"SAVE","duration":"${duration}","duration_in_months":2,"percent_off":20,"plan_keys":[]${extra}}'::jsonb where id=1`);
    await apply("once"); await issue("2026-11-01", 290); await issue("2026-11-01", 290);
    expect(await row("select plan_key, base_amount_cents, amount_cents, coupon_code, coupon_discount_cents from onchain_invoices where period_start='2026-11-01'"))
      .toEqual({ plan_key: "member_2day", base_amount_cents: 5000, amount_cents: 3884, coupon_code: "SAVE", coupon_discount_cents: 1000 });
    await db.exec("update subscriptions set onchain_coupon = onchain_coupon || '{\"stripe_redemptions\":9}'::jsonb where id=1");
    expect((await row("select onchain_coupon_start from subscriptions where id=1")).onchain_coupon_start).toBeTruthy();
    await issue("2026-12-01");
    expect((await row("select amount_cents from onchain_invoices where period_start='2026-12-01'")).amount_cents).toBe(5000);
    await apply("repeating");
    for (const [index, date] of ["2027-01-01", "2027-02-01", "2027-03-01"].entries()) {
      await db.exec(`update subscriptions set onchain_coupon = onchain_coupon || '{"stripe_redemptions":${12 + index}}'::jsonb where id=1`);
      await issue(date);
    }
    expect((await row("select array_agg(amount_cents order by period_start) amounts from onchain_invoices where period_start >= '2027-01-01'")).amounts).toEqual([4000,4000,5000]);
    await db.exec(`update subscriptions set onchain_coupon='{"code":"FLAT","duration":"forever","amount_off":2000,"plan_keys":["member_2day"]}' where id=1`);
    await issue("2027-04-01");
    expect((await row("select amount_cents from onchain_invoices where period_start='2027-04-01'")).amount_cents).toBe(3000);
    await db.exec("update subscriptions set plan_key='member_basic', monthly_cents=3000 where id=1"); await issue("2027-05-01");
    expect((await row("select amount_cents from onchain_invoices where period_start='2027-05-01'")).amount_cents).toBe(3000);
    await db.exec(`update subscriptions set onchain_coupon='{"code":"FREE","duration":"forever","percent_off":100,"plan_keys":[]}' where id=1`); await issue("2027-06-01");
    expect((await row("select amount_cents from onchain_invoices where period_start='2027-06-01'")).amount_cents).toBe(100);
    // Credit the old invoice after the prospective plan has changed.
    const credit = "select * from credit_onchain_invoice(1,'tx',0,1,'block','from','to','token',500000000,'included',null)";
    expect((await row(credit)).plan_key).toBe("cold_desk");
    expect((await row(credit)).was_new).toBe(false);
  } finally { await db.close(); }
}, 20000);
