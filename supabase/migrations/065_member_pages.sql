-- Migration 065: member pages and the member directory (T-482).
--
-- A member in standing (lib/memberStanding.ts) who opts in gets a public page at /members/<techne-handle> (or
-- /members/<id> without a Techne link) and a place in the directory at /members. Only these columns and name,
-- bio, skills and photo are ever public; email, plan, payment and door data never are.
--
--   show_in_directory  the opt-in. Migration 005 added it (not null, default true) and nothing ever read it; it now
--                      means: null = not asked yet (the portal asks once), false = said no, true = listed while in
--                      standing. Everyone starts unasked except co-op owners, who were the whole directory before
--                      this and stay listed so the landing page doesn't empty out.
--   working_on         one short line, the headline of the page and the directory card
--   links              up to five http(s) URLs
--   show_rsvps         show the hub nights they RSVP'd to recently on their page (default off)
--
-- Reverse: alter table members drop column working_on, drop column links, drop column show_rsvps;
--   update members set show_in_directory = true where show_in_directory is null;
--   alter table members alter column show_in_directory set default true, alter column show_in_directory set not null;
set local lock_timeout = '5s';

alter table members
  alter column show_in_directory drop not null,
  alter column show_in_directory drop default,
  add column working_on text check (char_length(working_on) <= 140),
  add column links text[] not null default '{}' check (cardinality(links) <= 5),
  add column show_rsvps boolean not null default false;

update members set show_in_directory = case when is_coop_member then true else null end;
