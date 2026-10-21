# T-241c progress — admin "Cancel membership" + Overdue filter

## Done
- `lib/membershipCancel.ts`: one `cancelMembership()` for both rails + `endOnchainSubscriptionsAtPeriodEnd()` sweep.
- Route `api/admin/members/[id]/cancel-membership` (session → requireAdmin → service client), with tests.
- `lib/onchain/invoice.ts`: `cancel_at_period_end` subs get no new invoice; the on-chain billing cron runs the period-end sweep first.
- UI: `components/admin/CancelMembershipCard.tsx` on the Billing tab; Overdue filter on /admin/members (`lib/adminMemberFilters.ts`).
- Audit: `SUBSCRIPTION_CANCELED_BY_ADMIN`, target `members`, shown in Activity.
- No migration needed (059 unused).
- Two self-review rounds fixed: reactivation via paying a leftover invoice (crypto cancel-now voids every open/exception invoice first, refuses with 409 while a payment is in flight), part-way failures stay retryable, lost Stripe webhook, default subscription picks the paying one over a newer abandoned checkout.
- Walkthrough video recorded (`~/.hermes/cache/scratch/t241/walkthrough-cancel.mp4`), scripts in `cancel-walkthrough-src/`.

## Next (attempt 2)
- Gates, `/code-review`, re-record video on the final build if behaviour changed, REPORT.md.

## Open questions
- Cancel at period end: should unpaid current-period invoices still be voided? (checkbox decides; ask Aaron)
- origin/main gained #112 (eadfe19) after this branch was cut; check the merge.
