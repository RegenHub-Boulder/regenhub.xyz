import Link from "next/link";
import { Archive, CalendarDays, Coffee, Presentation, UserRound } from "lucide-react";
import { DAY_PASS_MEMBER_CENTS, DAY_PASS_PUBLIC_CENTS, MEMBER_DAY_PLANS, formatCents } from "@/lib/plans";
import { getSeries, rhythmOf } from "@/lib/series";

/**
 * What a member gets (Aaron, 11-20): the practice first (demos, Studio Night, the member page and directory, the archive), then
 * the coworking days by plan. The days and prices come from lib/plans.ts and Studio Night's rhythm from
 * lib/series.ts, so this copy can't drift from what's sold or posted.
 */

function daysLine(): string {
  return MEMBER_DAY_PLANS.map(
    (p) => `${formatCents(p.defaultMonthlyCents)} a month includes ${p.monthlyDayPasses} day${p.monthlyDayPasses === 1 ? "" : "s"}`,
  ).join(", ");
}

const time = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
};

export function MemberOffer() {
  const studio = getSeries("studio-night");
  const items = [
    {
      icon: Presentation,
      title: "Member demos",
      body: (
        <>
          The Friday demos before{" "}
          <Link href="/events/happy-hour" className="text-sage underline">
            420 Happy Hour
          </Link>{" "}
          are for members, and members get first claim on demo slots at Techne Tuesdays.
        </>
      ),
    },
    {
      icon: CalendarDays,
      title: "Studio Night",
      body: (
        <>
          {studio ? `${rhythmOf(studio)}, ${time(studio.startTime)}–${time(studio.endTime)}pm. ` : ""}
          Hang out with other members and get help with your agent, your data, your tools.{" "}
          <Link href="/events/studio-night" className="text-sage underline">
            See the nights
          </Link>
        </>
      ),
    },
    {
      icon: UserRound,
      title: "Your member page",
      body: (
        <>
          A page of your own and a place in the{" "}
          <Link href="/members" className="text-sage underline">
            member directory
          </Link>
          , on your Techne account, if you want one.
        </>
      ),
    },
    {
      icon: Archive,
      title: "The members' archive",
      soon: true,
      body: <>Recordings and notes from the nights.</>,
    },
    {
      icon: Coffee,
      title: "Coworking days",
      body: (
        <>
          {daysLine()}. Unused days carry over. Extra day passes are {formatCents(DAY_PASS_MEMBER_CENTS)} for members
          instead of {formatCents(DAY_PASS_PUBLIC_CENTS)}.
        </>
      ),
    },
  ];

  return (
    <section className="space-y-4" aria-labelledby="member-offer" data-testid="member-offer">
      <h2 id="member-offer" className="text-2xl font-semibold text-forest text-center">
        What members get
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {items.map(({ icon: Icon, title, body, soon }) => (
          <li key={title} className="glass-panel-subtle rounded-lg p-5 flex gap-3">
            <Icon className="w-5 h-5 text-sage shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold">
                {title}
                {soon && <span className="ml-2 text-xs font-normal text-muted">Coming soon</span>}
              </p>
              <p className="text-sm text-muted leading-relaxed">{body}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
