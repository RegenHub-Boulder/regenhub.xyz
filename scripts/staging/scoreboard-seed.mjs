// STAGING ONLY. Fictional rows for /admin/scoreboard (T-497), loaded by supabase-standin.mjs --scoreboard.
// They are the rows of apps/web/src/lib/scoreboard.test.ts (member ids + 100), plus four the unit tests cover on
// their own (an unpaid USDC checkout an admin cancelled, a card member set to end, a full comp, and a USDC cancel
// asked in October that ended in November), and a newsletter issue. scoreboard-shots.mjs checks the page against
// the numbers worked by hand from these rows. The sample steward becomes an admin to read the page.
// Nobody here is a real person; every email is @example.test.

const subs = [
  // id, member, plan, status, monthly, net, rail, created, canceled_at, updated_at
  [1, 101, "hot_desk", "active", 25000, 25000, "stripe", "2026-06-10T16:00:00Z"],
  [2, 102, "cold_desk", "active", 50000, 37500, "stripe", "2026-08-03T16:00:00Z"],
  [3, 103, "member_5day", "active", 10000, 9500, "onchain", "2026-10-05T16:00:00Z"],
  [4, 104, "member_basic", "trialing", 3000, null, "stripe", "2026-11-02T16:00:00Z"],
  [5, 105, "hot_desk", "past_due", 25000, 25000, "stripe", "2026-07-01T16:00:00Z"],
  [6, 106, "member_basic", "active", 3000, 1500, "stripe", "2026-09-12T16:00:00Z"],
  [7, 107, "member_2day", "canceled", 5000, 5000, "stripe", "2026-06-20T16:00:00Z", "2026-11-01T03:00:00Z"],
  [8, 108, "hot_desk", "canceled", 25000, 23750, "onchain", "2026-07-07T16:00:00Z"], // admin cancel, dated below
  [9, 109, "cold_desk", "incomplete", 50000, 50000, "stripe", "2026-11-10T16:00:00Z"],
  [10, 101, "member_basic", "canceled", 3000, 3000, "stripe", "2026-05-01T16:00:00Z", "2026-06-09T16:00:00Z"],
  [11, 110, "hot_desk", "active", 25000, 30000, "onchain", "2026-11-15T16:00:00Z"],
  [12, 111, "member_2day", "canceled", 5000, 5000, "stripe", "2026-03-01T16:00:00Z", "2026-06-20T16:00:00Z"],
  // A USDC checkout Sample 12 never paid, then cancelled by an admin: it must count nowhere.
  [13, 112, "hot_desk", "canceled", 25000, 23750, "onchain", "2026-10-10T16:00:00Z", "2026-10-12T16:00:00Z"],
  // Sample 16 asked on Nov 8 to cancel at period end: still paying, "set to end", on the follow-up list.
  [14, 116, "hot_desk", "active", 25000, 25000, "stripe", "2026-09-01T16:00:00Z", "2026-11-08T16:00:00Z"],
  // Sample 17 is on a full comp: a $30 plan at $0, so not a paying member for the goal.
  [15, 117, "member_basic", "active", 3000, 0, "stripe", "2026-11-04T16:00:00Z"],
];
const types = { 101: "hot_desk", 102: "cold_desk", 105: "hot_desk", 108: "hot_desk", 110: "hot_desk", 116: "hot_desk" };
const members = Array.from({ length: 17 }, (_, i) => {
  const id = 101 + i;
  return [id, `Sample ${i + 1}`, id === 113 ? "pat@example.test" : `sample${i + 1}@example.test`, types[id] ?? "day_pass", id === 114];
});
const purchases = [
  [112, "sample12@example.test", "2026-10-02T16:00:00Z", null],
  [112, null, "2026-11-12T16:00:00Z", 7],
  [null, "walkin@example.test", "2026-09-09T16:00:00Z", null],
  [null, "Pat@Example.test", "2026-08-08T16:00:00Z", null],
  [102, null, "2026-07-20T16:00:00Z", null],
  [109, null, "2026-11-11T16:00:00Z", null],
];
const visits = [
  [107, "2026-10-20T16:00:00Z"], [112, "2026-11-15T16:00:00Z"], [112, "2026-10-01T16:00:00Z"],
  [113, "2026-08-09T16:00:00Z"], [null, "2026-11-19T16:00:00Z"],
];
const interests = [
  ["sample3@example.test", "2026-06-05T16:00:00Z"], ["friend1@example.test", "2026-11-01T05:00:00Z"],
  ["friend2@example.test", "2026-11-10T16:00:00Z"], ["old@example.test", "2025-12-01T16:00:00Z"],
];
const applications = [["sample15@example.test", "2026-09-01T16:00:00Z"], ["sample16@example.test", "2026-11-05T16:00:00Z"]];

export async function seedScoreboard(pg) {
  await pg.exec(`
    create table subscriptions (
      id serial primary key, member_id integer not null, payment_rail text not null default 'stripe', plan_key text not null,
      monthly_cents integer not null, net_cents integer, status text not null, canceled_at timestamptz,
      cancel_at_period_end boolean not null default false, admin_canceled_at timestamptz, admin_cancel_mode text,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table interests (id serial primary key, email text not null, name text, created_at timestamptz not null default now());
    create table applications (id serial primary key, email text not null, name text not null, created_at timestamptz not null default now());
    create table purchases (id serial primary key, member_id integer, email text, onchain_invoice_id integer,
      amount_cents integer not null default 3000, passes_granted integer not null default 1, created_at timestamptz not null default now());
    create table access_logs (id serial primary key, member_id integer, result text not null default 'granted',
      created_at timestamptz not null default now());
    create table onchain_invoices (id serial primary key, subscription_id integer not null, status text not null,
      kind text not null default 'membership');
    create table email_unsubscribes (email text primary key, created_at timestamptz not null default now());
    create table newsletter_issues (id serial primary key, issue_key text not null unique, subject text not null,
      status text not null default 'sent', created_at timestamptz not null default now());
    create table newsletter_sends (id bigserial primary key, issue_id integer not null, email text not null,
      status text not null default 'pending', attempts integer not null default 0);
    update members set is_admin = true where email = 'steward@regenhub.test';`);
  for (const [id, name, email, type, disabled] of members) {
    await pg.query("insert into members(id, name, email, member_type, disabled) values ($1, $2, $3, $4, $5)", [id, name, email, type, disabled]);
  }
  for (const [id, member, plan, status, monthly, net, rail, created, canceledAt, updatedAt] of subs) {
    await pg.query(
      `insert into subscriptions(id, member_id, plan_key, status, monthly_cents, net_cents, payment_rail, created_at, canceled_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, member, plan, status, monthly, net, rail, created, canceledAt ?? null, updatedAt ?? created],
    );
  }
  // Sub 8: an admin asked on Oct 25 (USDC, period end); it ended Nov 3. Counts in November.
  await pg.query("update subscriptions set admin_canceled_at = '2026-10-25T16:00:00Z', admin_cancel_mode = 'period_end', canceled_at = '2026-11-03T16:00:00Z' where id = 8");
  await pg.query("update subscriptions set cancel_at_period_end = true where id = 14");
  // The USDC subscriptions (3, 8, 11) were paid: a paid membership invoice each.
  for (const id of [3, 8, 11]) await pg.query("insert into onchain_invoices(subscription_id, status) values ($1, 'paid')", [id]);
  for (const [member, email, at, invoice] of purchases) {
    await pg.query("insert into purchases(member_id, email, created_at, onchain_invoice_id) values ($1, $2, $3, $4)", [member, email, at, invoice]);
  }
  for (const [member, at] of visits) await pg.query("insert into access_logs(member_id, created_at) values ($1, $2)", [member, at]);
  for (const [email, at] of interests) await pg.query("insert into interests(email, created_at) values ($1, $2)", [email, at]);
  for (const [email, at] of applications) await pg.query("insert into applications(email, name, created_at) values ($1, 'Applicant (sample)', $2)", [email, at]);
  await pg.query("insert into email_unsubscribes(email) values ('friend2@example.test')");
  await pg.query("insert into newsletter_issues(id, issue_key, subject, status, created_at) values (1, '2026-W46', 'The hub, mid-November (sample)', 'sent', '2026-11-12T17:00:00Z')");
  for (const [i, status] of ["sent", "sent", "sent", "sent", "failed"].entries()) {
    await pg.query("insert into newsletter_sends(issue_id, email, status) values (1, $1, $2)", [`reader${i}@example.test`, status]);
  }
  await pg.exec("select setval('members_id_seq', 200)");
}
