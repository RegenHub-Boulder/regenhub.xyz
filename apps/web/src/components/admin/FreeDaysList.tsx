import Link from "next/link";
import { ClaimActions } from "@/components/admin/ClaimActions";
import { FREE_DAY_GROUPS, freeDayApprovedByWords, type FreeDayGroup, type PlacedClaim } from "@/lib/freeDayFunnel";

/**
 * People → Free days: the claims grouped by where the person is now, one line each. Opens on "To review" (the
 * claims someone has to act on, the same count as "free-day requests to review" on the admin home); the other groups
 * are links (?show=…) styled like the People tabs above.
 */
export function FreeDaysList({ placed, counts, show, canApprove }: {
  placed: PlacedClaim[];
  counts: Record<FreeDayGroup, number>;
  show: FreeDayGroup;
  /** A co-op member (lib/approval.ts canApproveOnSite) approves or turns down a request; others see the lists. */
  canApprove: boolean;
}) {
  const rows = placed.filter((p) => p.group === show);
  const group = FREE_DAY_GROUPS.find((g) => g.key === show)!;
  return (
    <div className="space-y-4" data-testid="free-days">
      <p className="text-sm text-muted">
        A free day is good for any weekday; nobody picks a date. Each line says where the person is now.
      </p>
      <nav aria-label="Free days" className="flex gap-1 border-b border-rule overflow-x-auto">
        {FREE_DAY_GROUPS.map((g) => (
          <Link
            key={g.key}
            href={`/admin/people?tab=freedays&show=${g.key}`}
            aria-current={g.key === show ? "page" : undefined}
            className={`px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap transition-colors ${
              g.key === show ? "border-sage text-sage" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {g.label} <span className="text-xs tabular-nums">{counts[g.key]}</span>
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className="text-sm text-muted py-4">{group.empty}</p>
      ) : (
        <ul className="divide-y divide-rule border-b border-rule">
          {rows.map(({ claim, line, legacy }) => (
            <li key={claim.id} className="py-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4" data-group={show}>
              <div className="flex-1 min-w-0 space-y-0.5">
                <p className="text-sm">
                  <span className="font-medium">{claim.name}</span>{" "}
                  <span className="text-muted break-all">{claim.email}</span>
                </p>
                <p className="text-sm text-muted">
                  {line}
                  {legacy && <span> · {legacy}</span>}
                  {freeDayApprovedByWords(claim) && <span data-testid="free-day-approved-by"> · {freeDayApprovedByWords(claim)}</span>}
                </p>
                {(claim.about || claim.why_join) && (
                  <details className="text-sm text-muted">
                    <summary className="cursor-pointer hover:text-foreground w-fit">What they wrote</summary>
                    {claim.about && <p className="mt-1"><span className="text-foreground">Working on:</span> {claim.about}</p>}
                    {claim.why_join && <p className="mt-1"><span className="text-foreground">Why visit:</span> {claim.why_join}</p>}
                  </details>
                )}
              </div>
              <ClaimActions claimId={claim.id} currentStatus={claim.status} canApprove={canApprove} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
