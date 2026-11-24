// STAGING ONLY (T-482 portal/admin audit). Sample rows on the REAL schema (supabase-standin.mjs --audit) so every
// portal and admin screen has something on it: members of each type and state, subscriptions on both rails (one past
// due, one ending, one switching, one awaiting its first USDC payment), applications, free-day claims, the stay-in-touch
// list, door codes, entries, a failed lock sync, a quarantined slot, newsletter issues. Dates are relative to now.
// A few rows are deliberately awkward (a very long name, an unbreakable email) to see how lists hold up.
// Nobody here is a real person; every email is @example.test or @regenhub.test.
const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const ahead = (days) => new Date(Date.now() + days * DAY).toISOString();

const PEOPLE = [
  // name, email, type, extra member columns
  ["Mira Okafor (sample)", "mira@example.test", "cold_desk", { is_coop_member: true, pin_code: "418302", pin_code_slot: 3, created_at: ago(400) }],
  ["Theo Lindqvist (sample)", "theo@example.test", "hot_desk", { pin_code: "551920", pin_code_slot: 4, created_at: ago(200) }],
  ["Priya Raman (sample)", "priya@example.test", "hot_desk", { pin_code: "770114", pin_code_slot: 5, created_at: ago(150) }],
  ["Dee Castillo (sample)", "dee@example.test", "hub_friend", { pin_code: "309921", pin_code_slot: 6, created_at: ago(90) }],
  ["Bo Nguyen (sample)", "bo@example.test", "day_pass", { created_at: ago(40) }],
  ["Alexandria Wilhelmina Featherstonehaugh-Montgomery (sample)", "alexandria.wilhelmina.featherstonehaugh.montgomery@example.test", "day_pass", { created_at: ago(12) }],
  ["Ren (sample)", "ren@example.test", "hot_desk", { pin_code: "662810", pin_code_slot: 7, created_at: ago(60) }],
  ["Uma Patel (sample)", "uma@example.test", "cold_desk", { pin_code: "120934", pin_code_slot: 8, created_at: ago(30) }],
  ["Gus Ferreira (sample)", "gus@example.test", "day_pass", { created_at: ago(5) }],
  ["Old Account (sample)", "old@example.test", "hot_desk", { disabled: true, created_at: ago(500) }],
  ["Sam Sample", "sam-sample@example.test", "day_pass", { created_at: ago(0.2) }],
  // Free-day claimants (round 3): their member rows, as the claim trigger makes them.
  ["Eve Entry (sample)", "eve@example.test", "day_pass", { created_at: ago(12) }],
  ["Bea Bought (sample)", "bea@example.test", "day_pass", { created_at: ago(30) }],
  ["Jo Joined (sample)", "jo@example.test", "day_pass", { created_at: ago(40) }],
];

export async function seedAudit(pg, people = []) {
  // Sample rows go straight in: the door-code guard (053) wants a PIN-writer reservation the app takes for real
  // writes, and the seed has no lock to talk to. Triggers are off for the seed only (keys too, so mind them).
  await pg.exec("set session_replication_role = replica");
  try { await seed(pg, people); } finally { await pg.exec("set session_replication_role = default"); }
}

async function seed(pg, people) {
  const q = (sql, args) => pg.query(sql, args);
  // The base people (supabase-standin.mjs): the steward runs the place; Ana is an established hot-desk member.
  await q(`update members set is_admin = true, is_ops_admin = true, is_coop_member = true, pin_code = '204611',
    pin_code_slot = 1, created_at = $1, bio = 'Keeps the lights on (sample).' where email = 'steward@regenhub.test'`, [ago(700)]);
  await q(`update members set pin_code = '583027', pin_code_slot = 2, created_at = $1, bio = 'Gardener and Rust programmer.',
    telegram_username = '@ana_sample', show_in_directory = true, is_coop_member = true where email = 'ana-sample@example.test'`, [ago(320)]);

  const id = {};
  for (const [name, email, type, extra] of PEOPLE) {
    const cols = ["name", "email", "member_type", ...Object.keys(extra)];
    const vals = [name, email, type, ...Object.values(extra)];
    const r = await q(`insert into members(${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, vals);
    id[email] = r.rows[0].id;
  }
  // Sam signs in with Techne: link the row to Sam's sample Techne account, as a first sign-in would.
  const sam = people.find((p) => p.name.startsWith("Sam"));
  if (sam) await q("update members set did = $1 where email = 'sam-sample@example.test'", [sam.did]);
  const m = async (email) => id[email] ?? (await q("select id from members where email = $1", [email])).rows[0].id;
  const ana = await m("ana-sample@example.test");
  const steward = await m("steward@regenhub.test");

  // Uma pays in USDC, from a verified wallet.
  const uma = id["uma@example.test"];
  const w = await q(`insert into member_wallets(member_id, address, verification_method, verified_at)
    values ($1, '0x5a3e000000000000000000000000000000c0ffee', 'signature', now()) returning id`, [uma]);
  // Subscriptions: card unless said otherwise.
  const subs = [
    [ana, "hot_desk", 25000, 25000, "active", { current_period_end: ahead(18), created_at: ago(300) }],
    [steward, "cold_desk", 50000, 0, "active", { current_period_end: ahead(18), created_at: ago(600), discount_cents: 50000, discount_note: "Steward comp" }],
    [id["mira@example.test"], "cold_desk", 50000, 45000, "active", { current_period_end: ahead(9), created_at: ago(390) }],
    [id["theo@example.test"], "hot_desk", 25000, 25000, "past_due", { past_due_since: ago(6), current_period_end: ago(6), created_at: ago(190) }],
    [id["priya@example.test"], "hot_desk", 25000, 25000, "active", { cancel_at_period_end: true, current_period_end: ahead(11), created_at: ago(140) }],
    [id["dee@example.test"], "member_basic", 3000, 3000, "active", { current_period_end: ahead(20), created_at: ago(80) }],
    [id["ren@example.test"], "hot_desk", 25000, 25000, "active", { current_period_end: ahead(14), created_at: ago(55),
      pending_plan_key: "member_5day", pending_plan_at: ahead(14), pending_plan_from: "hot_desk", pending_plan_schedule_id: "sub_sched_sample" }],
    [id["uma@example.test"], "cold_desk", 50000, 47500, "incomplete", { payment_rail: "onchain", wallet_id: w.rows[0].id, created_at: ago(2) }],
    [id["bo@example.test"], "member_2day", 5000, 5000, "active", { current_period_end: ahead(3), created_at: ago(35) }],
    [id["old@example.test"], "hot_desk", 25000, 25000, "canceled", { canceled_at: ago(60), created_at: ago(480) }],
  ];
  const subId = {};
  for (const [member, plan, monthly, net, status, extra] of subs) {
    if (!extra.payment_rail) Object.assign(extra, { stripe_subscription_id: `sub_sample_${member}`, stripe_customer_id: `cus_sample_${member}`, stripe_price_id: `price_sample_${plan}` });
    const cols = ["member_id", "plan_key", "monthly_cents", "net_cents", "status", ...Object.keys(extra)];
    const vals = [member, plan, monthly, net, status, ...Object.values(extra)];
    const r = await q(`insert into subscriptions(${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, vals);
    subId[member] = r.rows[0].id;
  }
  // Uma's first USDC invoice.
  await q(`insert into onchain_invoices(subscription_id, member_id, period_start, period_end, due_at, base_amount_cents,
    amount_cents, amount_usdc_micros, status, plan_key) values ($1, $2, now(), $3, $4, 50000, 47500, 475000000, 'open', 'cold_desk')`,
  [subId[uma], uma, ahead(30), ahead(1)]);

  // Ana's guest passes and the door codes out now (day codes use slots 101+).
  const dp = await q("insert into day_passes(member_id, allowed_uses, used_count, expires_at) values ($1, 5, 2, $2) returning id", [ana, ahead(60)]);
  await q("update members set day_passes_balance = 3 where id = $1", [ana]);
  const codes = [
    [dp.rows[0].id, ana, "Guest of Ana: Kai (sample)", "731904", 101, ago(0.1), ahead(0.5), true],
    [null, steward, "Plumber (sample)", "402288", 102, ago(0.3), ahead(0.03), true],
    [null, id["gus@example.test"], "Free day", "915530", 103, ago(0.2), ahead(0.6), true],
    [dp.rows[0].id, ana, "Guest of Ana: Lou (sample)", "118845", 104, ago(9), ago(8), false],
    [null, id["bo@example.test"], "Day pass", "640071", 105, ago(4), ago(3), false],
  ];
  for (const [pass, member, label, code, slot, issued, expires, active] of codes) {
    await q(`insert into day_codes(day_pass_id, member_id, label, code, pin_slot, issued_at, expires_at, is_active, revoked_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [pass, member, label, code, slot, issued, expires, active, active ? null : expires]);
  }

  // Door entries: several today (the "here now" count), and a week of history.
  const entries = [
    [ana, "pin", 0.05], [id["mira@example.test"], "pin", 0.1], [steward, "pin", 0.15], [id["theo@example.test"], "pin", 0.2],
    [id["gus@example.test"], "daycode", 0.12], [ana, "pin", 1.1], [id["priya@example.test"], "pin", 1.3], [id["dee@example.test"], "pin", 2.2],
    [ana, "pin", 3.1], [id["mira@example.test"], "pin", 4.2], [id["bo@example.test"], "daycode", 4.1], [null, "pin", 0.3],
  ];
  for (const [member, method, d] of entries) {
    await q("insert into access_logs(member_id, method, result, created_at) values ($1, $2, $3, $4)", [member, method, member ? "granted" : "denied", ago(d)]);
  }

  // The pipeline: stay-in-touch signups, free-day claims, applications.
  for (const [email, name, d] of [["fern@example.test", "Fern (sample)", 1], ["hal@example.test", null, 3], ["ivy@example.test", "Ivy (sample)", 8],
    ["jun@example.test", "Jun (sample)", 15], ["bo@example.test", "Bo Nguyen (sample)", 50], ["kit@example.test", null, 70]]) {
    await q("insert into interests(email, name, source_path, interests, created_at) values ($1, $2, '/interest', '{coworking,events}', $3)", [email, name, ago(d)]);
  }
  // Free days (round 3): no date since flexible free days (claimed_date null), one legacy claim with the date it once
  // asked for, people already members when they claimed, and people who came in, bought a pass or joined since.
  const claims = [
    // email, name, status, claimed_date, days ago, about, why_join, activated days ago
    ["nora@example.test", "Nora (sample)", "pending", null, 1, "Freelance illustrator.", "Looking for a quiet desk two days a week.", null],
    ["mira@example.test", "Mira Okafor (sample)", "pending", null, 2, "Already has a desk.", "Bringing a friend? Clicked the wrong link.", null],
    ["sam-sample@example.test", "Sam Sample", "reserved", null, 0.3, "Climate data person.", "Heard about Agents Building Night.", null],
    ["pat@example.test", "Pat (sample)", "reserved", null, 9, "Teaches high-school physics.", "Wants to see the space.", null],
    ["lee@example.test", "Lee Legacy (sample)", "reserved", "2026-09-04", 80, "Writes grant proposals.", "Picked a date back when we asked for one.", null],
    ["theo@example.test", "Theo Lindqvist (sample)", "reserved", null, 20, "Hot desk member.", "Claimed out of habit.", null],
    ["gus@example.test", "Gus Ferreira (sample)", "activated", null, 2, "Bike mechanic.", "Friend of Mira.", 0.2],
    ["eve@example.test", "Eve Entry (sample)", "reserved", null, 12, "Product manager.", "Between jobs.", null],
    ["bea@example.test", "Bea Bought (sample)", "activated", null, 30, "Ceramicist.", "Needs a laptop day.", 29],
    ["jo@example.test", "Jo Joined (sample)", "activated", null, 40, "Climate founder.", "Looking for a home base.", 39],
    ["cy@example.test", "Cy (sample)", "cancelled", null, 5, "Crypto.", "Mailing address.", null],
    // Round 4: approved 100 days ago and never used, so it lapsed (lib/freeDayClaim.ts lapseFreeDays).
    ["lu@example.test", "Lu Lapsed (sample)", "expired", null, 100, "Documentary editor.", "Wanted a quiet day.", null],
  ];
  for (const [email, name, status, date, d, about, why, act] of claims) {
    await q(`insert into free_day_claims(email, name, status, claimed_date, about, why_join, created_at, activated_at, invited_by_member_id)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [email, name, status, date, about, why, ago(d), act == null ? null : ago(act), email === "pat@example.test" ? ana : null]);
  }
  if (process.env.T482_FREEDAY) {
    // First visits (T-482): Ana invited Sam, and eight weeks of mornings for "who's usually here": Monday to Thursday
    // someone opens the door about 7:45 (14:45 UTC, Boulder in winter), Fridays mostly after lunch. Unattributed, as
    // the HA history poll writes them.
    await q("update free_day_claims set invited_by_member_id = $1 where email = 'sam-sample@example.test'", [ana]);
    const DAY = 86_400_000;
    for (let i = 1; i <= 56; i += 1) {
      const d = new Date(Date.now() - i * DAY);
      const wd = d.getUTCDay(), date = d.toISOString().slice(0, 10);
      const times = wd >= 1 && wd <= 4 ? ["14:45", "16:20"] : wd === 5 ? [i <= 14 ? "16:40" : "19:30"] : [];
      for (const t of times) {
        await q("insert into access_logs(member_id, method, result, note, created_at) values (null, 'pin', 'granted', 'HA:lock.front_door_lock', $1)", [`${date}T${t}:00Z`]);
      }
    }
  }
  // The approval trigger (off for the seed) gives a reserved claim its one pass: Sam's is waiting.
  await q("update members set day_passes_balance = 1 where email = 'sam-sample@example.test'");
  await q("insert into access_logs(member_id, method, result, created_at) values ($1, 'daycode', 'granted', $2)", [id["eve@example.test"], ago(10)]);
  await q("insert into access_logs(member_id, method, result, created_at) values ($1, 'daycode', 'granted', $2)", [id["bea@example.test"], ago(29)]);
  await q("insert into purchases(member_id, kind, amount_cents, passes_granted, email, created_at) values ($1, 'day_pass', 3000, 1, 'bea@example.test', $2)", [id["bea@example.test"], ago(20)]);
  await q(`insert into subscriptions(member_id, plan_key, monthly_cents, net_cents, status, current_period_end, created_at,
    stripe_subscription_id, stripe_customer_id, stripe_price_id) values ($1, 'member_basic', 3000, 3000, 'active', $2, $3, 'sub_sample_jo', 'cus_sample_jo', 'price_sample_member_basic')`,
  [id["jo@example.test"], ahead(5), ago(25)]);
  await q(`insert into applications(email, name, about, why_join, membership_interest, status, telegram, created_at) values
    ('olu@example.test', 'Olu (sample)', 'Runs a small solar co-op.', 'Wants a hot desk near other builders.', 'hot_desk', 'pending', '@olu_sample', $1),
    ('pia@example.test', 'Pia (sample)', 'Grad student, soil science.', 'Daily membership, two days a week.', 'daily', 'pending', null, $2),
    ('bo@example.test', 'Bo Nguyen (sample)', 'Product designer.', 'Two days a week.', 'daily', 'approved', '@bo_sample', $3),
    ('zed@example.test', 'Zed (sample)', 'Crypto trader.', 'Wanted a mailing address.', 'cold_desk', 'rejected', null, $4)`,
  [ago(0.5), ago(2), ago(36), ago(20)]);

  // T482_JOIN=1 (T-482 round 5, one way to join): each state of an application, an approved member who hasn't picked a
  // plan, and a member on a day plan who can ask about a desk. Triggers are off here, so old and new flags are both set.
  if (process.env.T482_JOIN) {
    const dee = await m("dee@example.test"), mira = await m("mira@example.test"), sam = await m("sam-sample@example.test");
    const hrs = (h) => new Date(Date.now() - h * 3600000).toISOString();
    await q(`update applications set known_by_member_id = $1, how_found = 'Dee brought me to a Civic Tech Night', created_at = $2,
      about = 'Runs a small solar co-op.' where email = 'olu@example.test'`, [dee, hrs(30)]);
    await q(`update applications set how_found = 'Searched for coworking in Boulder', created_at = $1 where email = 'pia@example.test'`, [hrs(2)]);
    await q(`insert into applications(email, name, about, how_found, status, created_at, known_by_member_id, vouched_by, vouched_at)
      values ('kai@example.test', 'Kai (sample)', 'Builds tools for watershed data.', 'Agents Building Night', 'pending', $1, $2, $2, $3)`,
    [hrs(5), mira, hrs(1)]);
    await q(`update applications set known_by_member_id = $1, vouched_by = $1, vouched_at = $2, approved_by = $3 where email = 'bo@example.test'`, [mira, ago(36), steward]);
    // Sam: vouched for by Ana, approved yesterday by the steward; hasn't picked a plan.
    await q(`insert into applications(email, name, about, how_found, status, created_at, known_by_member_id, vouched_by, vouched_at, approved_by, supabase_user_id)
      values ('sam-sample@example.test', 'Sam Sample', 'Makes maps of who grows what.', 'A free day', 'approved', $1, $2, $2, $3, $4, null)`,
    [ago(1.2), ana, ago(1.1), steward]);
    await q(`update members set member_approved = true, member_approved_at = $1, member_approved_by = $2,
      approved_for_daily = true, approved_for_daily_at = $1, approved_for_daily_by = $2 where id = $3`, [ago(1), steward, sam]);
    // Dee (on the $30 plan) signs in as Lee's sample Techne account, to ask about a desk.
    const lee = people.find((p) => p.name.startsWith("Lee"));
    if (lee) await q("update members set did = $1, member_approved = true, approved_for_daily = true where id = $2", [lee.did, dee]);
    // Gus (approved, on day passes) asked about a desk two days ago: Today's "asked about a desk".
    await q(`update members set member_approved = true, approved_for_daily = true, member_approved_at = $1, desk_asked_at = $2
      where email = 'gus@example.test'`, [ago(4), ago(2)]);
    // Two free-day requests waiting: one over a day (late), one fresh.
    await q(`insert into free_day_claims(email, name, status, about, why_join, created_at) values
      ('lu-wait@example.test', 'Lu Waiting (sample)', 'pending', 'Ceramics studio.', 'Curious about the space.', $1)`, [hrs(27)]);
  }

  // The door: the last lock sync failed on one slot; one slot is quarantined.
  await q(`insert into lock_sync_runs(triggered_by, synced, failed, partial, results, created_at)
    values ($1, 9, 1, 0, '[{"slot":4,"door":"back","ok":false,"error":"timeout (sample)"}]', $2)`, [steward, ago(0.4)]);
  // Quarantine as production had it on 11-23 (round 3): eight guest-code slots from one bad day, nobody holding them,
  // no door results recorded; and Theo's member slot, where one lock didn't confirm a new code.
  for (let slot = 110; slot <= 117; slot++) {
    await q(`insert into lock_slot_quarantine(slot, reason, quarantined_at) values ($1, 'SET threw or timed out; clear required before reuse', $2)`, [slot, "2026-10-09T16:12:00Z"]);
  }
  await q(`insert into lock_slot_quarantine(slot, reason, quarantined_at, door_results) values (4, 'SET incomplete; clear required before reuse', $1, $2)`,
    [ago(3), JSON.stringify([{ entity: "lock.front_door_lock", ok: true }, { entity: "lock.back_door_lock", ok: false, error: "timeout (sample)" }])]);

  // T482_STUCK_WRITER (writer lease): the door-code writer as production had it 11-20 to 11-23, a Web PIN writer that
  // died mid-change and was never heard from again, and two door-code changes that couldn't start behind it.
  // T482_WHO=1 (with T482_JOIN, migration 074: who approves): the steward is a site admin but NOT a co-op member, so
  // signing in as them shows "Co-op members approve"; Ana (co-op, not an admin) signs in to approve. Kai was vouched
  // for in the chat by someone whose Telegram isn't linked, and a free day was approved by @sky in the chat.
  if (process.env.T482_WHO && process.env.T482_JOIN) {
    await q("update members set is_coop_member = false where email = 'steward@regenhub.test'");
    await q(`update applications set vouched_by = null, vouched_by_telegram_id = 4242, vouched_by_telegram = 'river'
      where email = 'kai@example.test'`);
    await q(`insert into free_day_claims(email, name, status, about, approved_by, approved_by_telegram_id, created_at) values
      ('rio-chat@example.test', 'Rio Chat (sample)', 'reserved', 'Weaving.', '@sky', 6060, $1)`, [ago(0.3)]);
  }

  if (process.env.T482_STUCK_WRITER) {
    const lease = (await q("select to_regclass('public.lock_slot_writer') as t, exists(select 1 from information_schema.columns where table_name = 'lock_slot_writer' and column_name = 'renewed_at') as r")).rows[0];
    if (lease.t) {
      const since = ago(2.7);
      await q(`insert into lock_slot_writer(id, token, holder_label, acquired_at${lease.r ? ", renewed_at" : ""}) values (1, gen_random_uuid(), 'Web PIN writer', $1${lease.r ? ", $1" : ""})`, [since]);
      for (const d of [0.3, 0.05]) {
        await q(`insert into admin_actions(action, target_table, target_id, payload, created_at) values ('lock_writer_failed', 'lock_slot_writer', '1', $1, $2)`,
          [JSON.stringify({ holder: "Web PIN writer", busy: true, error: "Another door-code change is running; try again in a minute.", held_by: "Web PIN writer", held_since: since }), ago(d)]);
      }
    }
  }

  // Theo's emails (round 3), when migration 069 is there: what the member page's Emails list shows.
  if ((await q("select to_regclass('public.email_log') as t")).rows[0].t) {
    const theo = id["theo@example.test"];
    for (const [kind, subject, status, d, error] of [
      ["welcome", "Welcome to RegenHub", "sent", 190, null],
      ["monthly_passes", "Your monthly day passes are in", "sent", 36, null],
      ["payment_failed", "Update your RegenHub payment method", "sent", 6, null],
      ["payment_reminder", "Update your RegenHub payment method", "failed", 2, "Daily sending quota reached (sample)"],
    ]) {
      await q(`insert into email_log(member_id, email, kind, subject, provider, provider_id, status, error, sent_at)
        values ($1, 'theo@example.test', $2, $3, 'resend', $4, $5, $6, $7)`, [theo, kind, subject, status === "sent" ? `msg_sample_${kind}` : null, status, error, ago(d)]);
    }
  }

  // The newsletter: one sent, one draft.
  await q(`insert into newsletter_issues(issue_key, subject, status, markdown_body, recipients_count, sent_count, created_at) values
    ('2026-W46', 'The hub, mid-November (sample)', 'sent', '# The hub (sample)', 5, 4, $1),
    ('2026-W48', 'Studio Night and the winter calendar (sample)', 'draft', '# Draft (sample)', 0, 0, $2)`, [ago(8), ago(0.5)]);
  for (const [i, status] of ["sent", "sent", "sent", "sent", "failed"].entries()) {
    await q("insert into newsletter_sends(issue_id, email, status) values (1, $1, $2)", [`reader${i}@example.test`, status]);
  }
  await q(`insert into admin_actions(actor_member_id, action, target_table, target_id, payload, created_at) values
    ($1, 'approve_application', 'applications', '3', '{"sample":true}', $2)`, [steward, ago(36)]);
}
