import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DAY_PASS_MEMBER_CENTS,
  DAY_PASS_PUBLIC_CENTS,
  MEMBERSHIP_LADDER,
  formatCents,
} from "@/lib/plans";

/** One step of the ladder in a few words: 1, 2, 5 days a month, then every day, then a desk of your own. */
export function ladderLine(p: (typeof MEMBERSHIP_LADDER)[number]): string {
  if ("monthlyDayPasses" in p) return `${p.monthlyDayPasses} day${p.monthlyDayPasses === 1 ? "" : "s"} a month`;
  return p.ladderLine;
}

/**
 * The home page's membership (T-482, Aaron 11-21: the desks are membership too, not a separate block): one ladder
 * from the cheapest plan to a desk of your own, what every plan includes, Apply, and one "Not ready to join?" line
 * for the free day and the day pass. Every price comes from lib/plans.ts.
 */
export default function HomeMembership() {
  return (
    <>
      <ul className="border-b border-rule mb-6" data-testid="home-member-plans">
        {MEMBERSHIP_LADDER.map((p) => (
          <li key={p.label} className="border-t border-rule py-3 grid grid-cols-[7.5rem_1fr] sm:grid-cols-[8.5rem_1fr] items-baseline gap-x-4">
            <span className="text-lg">
              <span className="text-gold">{formatCents(p.defaultMonthlyCents)}</span>
              <span className="text-muted"> a month</span>
            </span>
            <span>{ladderLine(p)}</span>
          </li>
        ))}
      </ul>
      <p className="-mt-3 mb-6 text-sm text-muted">On the day plans, unused days carry over; they never expire.</p>
      <p className="mb-2 font-semibold">Every plan includes</p>
      <ul className="space-y-2 text-muted mb-8 list-disc pl-5 marker:text-sage">
        <li>
          <span className="text-foreground">Member demos:</span> the Friday demos before 420 Happy Hour, and first
          claim on demo slots at Techne Tuesdays.
        </li>
        <li>
          <span className="text-foreground">Studio Night:</span> hang out with other members and get help with your
          agent, your data, your tools.
        </li>
        <li>
          <span className="text-foreground">Your member page:</span> a page of your own and a place in the member
          directory.
        </li>
        <li>
          Extra day passes for {formatCents(DAY_PASS_MEMBER_CENTS)} instead of {formatCents(DAY_PASS_PUBLIC_CENTS)}.
        </li>
      </ul>
      <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
        <Link href="/apply">
          <Button className="btn-primary-glass px-8 py-3 text-lg gap-2">
            Apply to join
            <ArrowRight className="w-5 h-5" />
          </Button>
        </Link>
        <Link href="/membership" className="text-sage hover:underline">
          More about membership →
        </Link>
      </div>

      {/* Not ready to join: the free day, then the day pass (draft for Aaron) */}
      <p className="mt-10 text-center text-muted" data-testid="home-not-ready">
        Not ready to join?{" "}
        <Link href="/freeday" className="text-sage hover:underline">
          Your first day is free
        </Link>
        , then a day pass is {formatCents(DAY_PASS_PUBLIC_CENTS)}, weekdays 8 AM to 6 PM.
      </p>
    </>
  );
}
