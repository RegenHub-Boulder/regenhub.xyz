-- Migration 067: newsletter issues have an audience (T-482).
-- NOTE: the number may need bumping if another migration lands first; the file is self-contained.
--
--   'public'  (default)  members + the stay-in-touch list, minus unsubscribes: how every issue has gone so far.
--   'members'            only members in standing (lib/memberStanding.ts) with an email, minus unsubscribes.
--                        The web archive (/news) never shows these issues.
--
-- Existing issues become 'public'. newsletter_prepare already skips pending rows that are no longer in the
-- audience it is given, so switching a draft's audience and preparing again drops anyone who shouldn't get it.

alter table public.newsletter_issues
  add column if not exists audience text not null default 'public'
  check (audience in ('public', 'members'));
