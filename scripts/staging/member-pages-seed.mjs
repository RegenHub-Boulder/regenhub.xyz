// STAGING ONLY (T-482). Sample members for the member pages preview, on top of supabase-standin.mjs's three
// (the steward, Ana linked to Techne, Jo not linked). Every person here is fictional.
//   Ana      listed: hot desk, linked, a "working on" line, skills, links, shows her recent nights
//   Robin    the steward: never asked yet, so /portal asks
//   Jo       said no
//   Mara, Theo, Priya   listed without a Techne link (hub friend, cold desk, $50 member)
//   Quinn    opted in but on a $20 legacy plan: not listed;  Kit  opted in but lapsed: not listed
export async function seedMemberPages(pg) {
  await pg.exec(`
    update members set show_in_directory = true, working_on = 'A seed-library app for the community gardens',
      bio = 'Gardener and Rust programmer. Ask me about local-first sync or tomatoes.',
      skills = '{Rust,Local-first,Gardening}', links = '{https://example.org/ana-sample,https://github.com/ana-sample}',
      show_rsvps = true
      where email = 'ana-sample@example.test';
    update members set show_in_directory = null where email = 'steward@regenhub.test';
    update members set show_in_directory = false where email = 'jo-sample@example.test';
    insert into members (name, email, member_type, show_in_directory, working_on, bio, skills) values
      ('Mara Sample', 'mara-sample@example.test', 'hub_friend', true, 'Mapping who grows what in Boulder County',
        'Data person, map nerd.', '{Maps,Python,Civic data}'),
      ('Theo Sample', 'theo-sample@example.test', 'cold_desk', true, 'Writing a field guide to agent tools',
        null, '{Writing,Agents}'),
      ('Priya Sample', 'priya-sample@example.test', 'day_pass', true, null,
        'Product designer between projects; here most Tuesdays.', '{Design,Research,Facilitation,Figma,Workshops}'),
      ('Quinn Sample', 'quinn-sample@example.test', 'day_pass', true, 'Under $30: not listed', null, null),
      ('Kit Sample', 'kit-sample@example.test', 'day_pass', true, 'Lapsed: not listed', null, null);
    insert into subscriptions (member_id, plan_key, monthly_cents, status)
      select id, 'member_2day', 5000, 'active' from members where email = 'priya-sample@example.test'
      union all select id, 'legacy', 2000, 'active' from members where email = 'quinn-sample@example.test'
      union all select id, 'member_basic', 3000, 'canceled' from members where email = 'kit-sample@example.test';`);
}
