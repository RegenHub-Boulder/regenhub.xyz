-- Migration 028: Refine the "approved for membership" grandfathering
--
-- Migration 027 blanket-approved every existing member, including day_pass
-- members who never went through the free-day approval conversation. Those
-- folks shouldn't be auto-eligible for self-serve monthly subscriptions —
-- the whole point of the gate is that monthly contribution is a community
-- decision, not a checkout button.
--
-- Keep approved: desk members (cold/hot), hub_friends, and anyone who
-- already has an active/past_due/trialing subscription on file.
-- Revert to default false: day_pass members with no subscription.

update members
   set approved_for_membership = false,
       approved_for_membership_at = null,
       approved_for_membership_by = null
 where member_type = 'day_pass'
   and approved_for_membership = true
   and id not in (
     select coalesce(member_id, -1) from subscriptions
     where status in ('active','trialing','past_due')
   );
