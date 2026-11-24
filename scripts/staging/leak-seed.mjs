// STAGING ONLY. Fictional rows for "Where people drop off" on /admin/scoreboard (T-497), loaded by
// supabase-standin.mjs --leaks on top of --scoreboard. Shaped like Uni's first count on production (11-24: 68 free days
// approved, 30 came in, 8 joined, 3 claims with no member row), so the page reads as it will there. Nobody here is a
// real person; every email is @example.test. leak-shots.mjs checks the page against the counts worked out below.
//
// Free days: 68 approved claims from March to November (claim i on day 3 + 3.9i from Mar 1), plus 2 pending and 1
// declined (not counted) and 1 from Sample 1, a hot desk since June (already a member: not counted). Claim i came in
// when i % 9 < 4 (30 of them; not the 3 with no member row, i = 65, 66, 67). Eight came in and joined 14 days after
// asking, i = 0, 2, 9, 11, 18, 20, 27, 29, with 4, 3, 3, 2, 2, 2, 1, 1 paid months: the first five in USDC (paid
// invoices), the last three by card, ended so the months elapsed equal the months paid (staging has no Stripe).
// Day passes: 20 first purchases by new people, 9 of them came in, 2 joined (one paid a 2nd month).
// Given passes: 4 people, 2 came in.

const DAY = 86_400_000;
const at = (ms) => new Date(ms).toISOString();
const START = Date.parse("2026-03-01T17:00:00Z");

export async function seedLeaks(pg) {
  await pg.exec(`
    create table if not exists free_day_claims (id serial primary key, email text not null, name text not null,
      claimed_date date, status text not null default 'reserved', day_code_id integer, supabase_user_id uuid,
      invited_by_member_id integer, about text, why_join text, created_at timestamptz not null default now(),
      activated_at timestamptz, approved_at timestamptz);`);

  let subId = 300;
  let invoiceSub = [];
  const member = async (id, name, email) =>
    pg.query("insert into members(id, name, email, member_type) values ($1, $2, $3, 'day_pass')", [id, name, email]);
  const cameIn = (id, t) => pg.query("insert into access_logs(member_id, created_at, slot, method) values ($1, $2, 150, 'daycode')", [id, at(t)]);
  const join = async (id, t, months, rail) => {
    subId += 1;
    if (rail === "onchain") {
      await pg.query(`insert into subscriptions(id, member_id, plan_key, status, monthly_cents, net_cents, payment_rail, created_at, updated_at)
        values ($1, $2, 'member_basic', 'active', 3000, 2850, 'onchain', $3, $3)`, [subId, id, at(t)]);
      invoiceSub.push([subId, months]);
    } else {
      // Ended so that months elapsed (one at the start, one per 30 days) equal the months paid.
      const ended = t + ((months - 1) * 30 + 5) * DAY;
      await pg.query(`insert into subscriptions(id, member_id, plan_key, status, monthly_cents, net_cents, payment_rail, created_at, canceled_at, updated_at)
        values ($1, $2, 'member_basic', 'canceled', 3000, 3000, 'stripe', $3, $4, $4)`, [subId, id, at(t), at(ended)]);
    }
  };

  const joiners = new Map([[0, [4, "onchain"]], [2, [3, "onchain"]], [9, [3, "onchain"]], [11, [2, "onchain"]], [18, [2, "onchain"]],
    [20, [2, "stripe"]], [27, [1, "stripe"]], [29, [1, "stripe"]]]);
  for (let i = 0; i < 68; i++) {
    const t = START + (3 + Math.floor(i * 3.9)) * DAY;
    const email = `freeday${i + 1}@example.test`;
    const status = i % 9 < 4 ? "activated" : i % 5 === 0 ? "expired" : "reserved";
    const noRow = i >= 65;
    if (!noRow) await member(300 + i, `Free Day ${i + 1}`, email);
    await pg.query("insert into free_day_claims(email, name, status, created_at, activated_at) values ($1, $2, $3, $4, $5)",
      [email, `Free Day ${i + 1}`, noRow ? "reserved" : status, at(t), !noRow && status === "activated" ? at(t + 3 * DAY) : null]);
    if (!noRow && status === "activated") await cameIn(300 + i, t + 3 * DAY);
    if (joiners.has(i)) await join(300 + i, t + 14 * DAY, ...joiners.get(i));
  }
  // Not approved, and a member already: none of these count.
  for (const [email, status, t] of [["pending1@example.test", "pending", "2026-11-20T17:00:00Z"], ["pending2@example.test", "pending", "2026-11-22T17:00:00Z"],
    ["declined@example.test", "cancelled", "2026-09-02T17:00:00Z"], ["sample1@example.test", "reserved", "2026-08-02T17:00:00Z"]]) {
    await pg.query("insert into free_day_claims(email, name, status, created_at) values ($1, 'Sample (not counted)', $2, $3)", [email, status, t]);
  }

  // Day passes: 20 new buyers from June on; buyers 0-8 came in, 0 and 4 joined.
  for (let i = 0; i < 20; i++) {
    const id = 400 + i;
    const t = Date.parse("2026-06-02T17:00:00Z") + 8 * i * DAY;
    await member(id, `Pass Buyer ${i + 1}`, `passbuyer${i + 1}@example.test`);
    await pg.query("insert into purchases(member_id, created_at, kind, passes_granted) values ($1, $2, 'day_pass', 1)", [id, at(t)]);
    if (i < 9) await cameIn(id, t + 1 * DAY);
    if (i === 0) await join(id, t + 20 * DAY, 2, "onchain");
    if (i === 4) await join(id, t + 20 * DAY, 1, "onchain");
  }

  // Passes given by an admin (logged since T-497): four people, two came in.
  for (let i = 0; i < 4; i++) {
    const id = 450 + i;
    const t = Date.parse("2026-10-06T17:00:00Z") + 10 * i * DAY;
    await member(id, `Guest of the House ${i + 1}`, `gift${i + 1}@example.test`);
    await pg.query(`insert into admin_actions(action, target_table, target_id, payload, created_at)
      values ('passes_granted', 'members', $1, '{"amount": 2}', $2)`, [String(id), at(t)]);
    if (i < 2) await cameIn(id, t + 2 * DAY);
  }

  for (const [sub, months] of invoiceSub) {
    for (let k = 0; k < months; k++) await pg.query("insert into onchain_invoices(subscription_id, status) values ($1, 'paid')", [sub]);
    await pg.query("insert into onchain_invoices(subscription_id, status) values ($1, 'open')", [sub]);
  }
  await pg.exec("select setval('members_id_seq', 1000)");
}
