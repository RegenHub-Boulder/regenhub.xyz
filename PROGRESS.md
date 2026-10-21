# T-241c progress — admin "Cancel membership" + Overdue filter

## Done
- Read lifecycle, Stripe webhook, on-chain invoice + cron, past-due sweep, admin pages.

## Plan
- `lib/membershipCancel.ts` (new): one `cancelMembership()` for both rails + `endOnchainSubscriptionsAtPeriodEnd()` sweep.
- Route `api/admin/members/[id]/cancel-membership` (new). Auth: session → requireAdmin → service client.
- `lib/onchain/invoice.ts`: one-line filter so `cancel_at_period_end` subs get no new invoice.
- `api/cron/onchain-billing`: call the period-end sweep before invoice generation.
- UI: `components/admin/CancelMembershipCard.tsx` (new) on the Billing tab; Overdue filter on /admin/members.
- Audit: reuse `AuditAction.SUBSCRIPTION_CANCELED_BY_ADMIN`, target `members` so it shows in Activity.
- No migration needed so far (059 reserved if one becomes necessary).

## Next
- Failing tests → implementation → gates → walkthrough → review → REPORT.md.

## Open questions
- Cancel at period end: should unpaid current-period invoices still be voided? (checkbox decides; ask Aaron)
