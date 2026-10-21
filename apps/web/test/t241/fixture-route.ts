// Temporary walkthrough-only backend: no Supabase, Stripe or wallet imports.
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
const fixture = globalThis as typeof globalThis & { t241db?: Promise<PGlite> };
async function database() {
  if (process.env.T241_WALKTHROUGH !== "1") throw new Error("Fixture is disabled");
  fixture.t241db ??= (async () => {
    const pg = new PGlite();
    await pg.exec(`create role anon; create role authenticated; create role service_role;
      create table subscriptions(id integer primary key, member_id integer, payment_rail text, plan_key text, monthly_cents integer,
        status text, current_period_end timestamptz, net_cents integer, past_due_since timestamptz, access_disabled_at timestamptz);
      create table onchain_invoices(id bigserial primary key, subscription_id integer, member_id integer, period_start timestamptz,
        period_end timestamptz, base_amount_cents integer, discount_bps integer default 0, amount_cents integer, amount_usdc_micros bigint,
        status text default 'open', paid_at timestamptz, exception_reason text, unique(subscription_id, period_start));
      insert into subscriptions(id, member_id, payment_rail, plan_key, monthly_cents) values(1,7,'onchain','cold_desk',50000);`);
    await pg.exec(await readFile(process.cwd() + "/../../supabase/migrations/057_onchain_plan_discounts.sql", "utf8"));
    return pg;
  })();
  return fixture.t241db;
}
export async function PATCH(req: Request) {
  const pg = await database(); const body = await req.json();
  const plans: Record<string, number> = { member_basic: 3000, member_2day: 5000, member_5day: 10000, hot_desk: 25000, cold_desk: 50000 };
  if (body.plan_key) await pg.query("update subscriptions set plan_key=$1, monthly_cents=$2 where id=1", [body.plan_key, plans[body.plan_key]]);
  if (body.discount_code) await pg.query("update subscriptions set onchain_coupon=$1::jsonb where id=1", [JSON.stringify({ code: "SAVE20", percent_off: 20, duration: "forever", plan_keys: [] })]);
  return NextResponse.json({ ok: true, message: "Saved for the next invoice. Issued invoices keep their price; access changes when the new invoice is paid." });
}
export async function POST() {
  const pg = await database();
  const count = (await pg.query<{ n: number }>("select count(*)::integer n from onchain_invoices")).rows[0].n;
  await pg.query(`insert into onchain_invoices(subscription_id,member_id,period_start,period_end,base_amount_cents,discount_bps,amount_cents,amount_usdc_micros)
    values(1,7,'2026-11-01'::timestamptz + make_interval(months=>$1),'2026-12-01'::timestamptz + make_interval(months=>$1),50000,0,50000,500000000)`, [count]);
  return NextResponse.json({ invoices: (await pg.query("select * from onchain_invoices order by id")).rows });
}
