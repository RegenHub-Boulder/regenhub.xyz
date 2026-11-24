import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { CopyTextBlock } from "@/components/admin/CopyTextBlock";
import { DropOff } from "@/components/admin/DropOff";
import { planLabel } from "@/lib/plans";
import { SCOREBOARD_GOALS, SCOREBOARD_TZ, usd, type TurnoutEvent } from "@/lib/scoreboard";
import { readScoreboard } from "@/lib/scoreboardData";
import {
  LIST_SOURCES, MONTH_NOTES, PLAN_BUCKETS, rateText, type MonthRow, type PlanBreakdown, type Rate,
} from "@/lib/scoreboardMonths";

export const metadata = { title: "Scoreboard — Admin" };
export const dynamic = "force-dynamic";

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: SCOREBOARD_TZ }) : "—";
const dayShort = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: SCOREBOARD_TZ }) : "—";
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const pct = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0);

function Section({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="glass-panel">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {note && <p className="text-xs text-muted">{note}</p>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function Bar({ value, goal, marker }: { value: number; goal: number; marker?: { at: number; label: string } }) {
  return (
    <div className="relative h-2 rounded-full bg-tint mt-3">
      <div className="absolute inset-y-0 left-0 rounded-full bg-sage" style={{ width: `${pct(value, goal)}%` }} />
      {marker && (
        <div className="absolute -top-1 -bottom-1 w-px bg-gold" style={{ left: `${pct(marker.at, goal)}%` }} title={marker.label} />
      )}
    </div>
  );
}

const monthLong = (key: string) =>
  new Date(`${key}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

type Col = { label: string; cell: (r: MonthRow) => React.ReactNode };

function RateCell({ rate }: { rate: Rate | null }) {
  if (rate == null) return <span className="text-muted">—</span>;
  return (
    <>
      {rateText(rate)}
      <span className="block text-[11px] text-muted">{rate.converted}/{rate.base}</span>
    </>
  );
}

/** A count with its plans under it ("2 hot · 1 $30"), when there is one. */
function WithPlans({ n, r, k }: { n: number; r: MonthRow; k: "started" | "canceled" }) {
  const parts = PLAN_BUCKETS.filter((b) => r.memberships.byPlan[b.key][k] > 0)
    .map((b) => `${r.memberships.byPlan[b.key][k]} ${b.key === "hot" || b.key === "cold" ? b.label.split(" ")[0].toLowerCase() : b.label.split(" ")[0]}`);
  return (
    <>
      {n}
      {parts.length > 0 && <span className="block text-[11px] text-muted whitespace-nowrap">{parts.join(" · ")}</span>}
    </>
  );
}

/** The month table: one row per month (rows = months, so it reads like the sheet), grouped columns, sideways scroll. */
function MonthByMonth({ rows }: { rows: MonthRow[] }) {
  const used = (b: (typeof PLAN_BUCKETS)[number]) => b.key !== "other" || rows.some((r) => r.memberships.atEnd.byPlan.other.paying > 0);
  const groups: { title: string; cols: Col[] }[] = [
    { title: "Space visits", cols: [
      { label: "Member days", cell: (r) => r.visits.memberDays },
      { label: "Day-code days", cell: (r) => r.visits.dayCodeDays },
    ] },
    { title: "Site", cols: [{ label: "Visits", cell: () => null }] },
    { title: "Stay-in-touch list", cols: [
      { label: "At month end", cell: (r) => r.list.size },
      { label: "Added", cell: (r) => (
        <>
          {r.list.added}
          {r.list.added > 0 && (
            <span className="block text-[11px] text-muted whitespace-nowrap">
              {LIST_SOURCES.filter((src) => r.list.bySource[src.key] > 0).map((src) => `${r.list.bySource[src.key]} ${src.label.split(" ")[0]}`).join(" · ")}
            </span>
          )}
        </>
      ) },
    ] },
    { title: "Free days", cols: [
      { label: "Claimed", cell: (r) => r.freeDays?.claimed ?? <span className="text-muted">—</span> },
      { label: "Came in", cell: (r) => r.freeDays?.cameIn ?? <span className="text-muted">—</span> },
      { label: "Bought a pass", cell: (r) => r.freeDays?.boughtPass ?? <span className="text-muted">—</span> },
      { label: "Joined", cell: (r) => r.freeDays?.joined ?? <span className="text-muted">—</span> },
    ] },
    { title: "Day passes bought", cols: [
      { label: "Single, card", cell: (r) => r.passes.singleCard },
      { label: "Single, USDC", cell: (r) => r.passes.singleUsdc },
      { label: "5-pack, card", cell: (r) => r.passes.packCard },
      { label: "5-pack, USDC", cell: (r) => r.passes.packUsdc },
    ] },
    { title: "Memberships", cols: [
      { label: "Applied", cell: (r) => r.applications },
      { label: "New", cell: (r) => <WithPlans n={r.memberships.started} r={r} k="started" /> },
      { label: "Cancelled", cell: (r) => <WithPlans n={r.memberships.canceled} r={r} k="canceled" /> },
      { label: "First-time", cell: (r) => r.memberships.firstTime },
    ] },
    { title: "Paying at month end", cols: [
      ...PLAN_BUCKETS.filter(used).map((b) => ({ label: b.label, cell: (r: MonthRow) => r.memberships.atEnd.byPlan[b.key].paying })),
      { label: "Total", cell: (r) => <strong>{r.memberships.atEnd.total.paying}</strong> },
      { label: "Net / mo", cell: (r) => <strong>{usd(r.memberships.atEnd.total.netCents)}</strong> },
    ] },
    { title: "Conversions", cols: [
      { label: "List → day pass", cell: (r) => <RateCell rate={r.conversions.listToPass} /> },
      { label: "Day pass → member", cell: (r) => <RateCell rate={r.conversions.passToMember} /> },
      { label: "Night → member", cell: (r) => <RateCell rate={r.conversions.nightToMember} /> },
      { label: "Day plan → desk", cell: (r) => <RateCell rate={r.conversions.dayPlanToDesk} /> },
    ] },
  ];
  const cols = groups.flatMap((g) => g.cols.map((c, i) => ({ ...c, first: i === 0, site: g.title === "Site" })));
  const edge = (first: boolean) => (first ? "border-l border-rule" : "");
  return (
    <div className="overflow-x-auto" data-testid="month-table">
      <table className="text-sm tabular-nums border-collapse">
        <thead>
          <tr className="text-xs text-muted">
            <th className="sticky left-0 bg-sheet" />
            {groups.map((g) => (
              <th key={g.title} colSpan={g.cols.length} className="py-1 px-2 text-left font-semibold border-l border-rule whitespace-nowrap">{g.title}</th>
            ))}
          </tr>
          <tr className="text-xs text-muted border-b border-rule">
            <th className="sticky left-0 bg-sheet py-1.5 pr-3 text-left font-medium">Month</th>
            {cols.map((c) => <th key={c.label} className={`py-1.5 px-2 text-right font-medium align-bottom ${edge(c.first)}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r.month} className="border-b border-rule align-top" data-month={r.month}>
              <th scope="row" className="sticky left-0 bg-sheet py-1.5 pr-3 text-left font-medium whitespace-nowrap">
                {monthLong(r.month)}{r.soFar && <span className="block text-[11px] font-normal text-muted">so far</span>}
              </th>
              {cols.map((c) => c.site
                ? ri === 0 && (
                  <td key={c.label} rowSpan={rows.length} className={`py-1.5 px-2 text-xs text-muted align-middle text-center ${edge(true)}`}>not tracked yet</td>
                )
                : <td key={c.label} className={`py-1.5 px-2 text-right ${edge(c.first)}`}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ByPlanNow({ plans }: { plans: PlanBreakdown }) {
  const rows = PLAN_BUCKETS.filter((b) => {
    const c = plans.byPlan[b.key];
    return b.key !== "other" || c.paying + c.comped + c.pastDue > 0;
  });
  return (
    <table className="w-full text-sm tabular-nums" data-testid="by-plan">
      <thead>
        <tr className="text-xs text-muted border-b border-rule">
          <th className="py-1.5 pr-4 text-left font-medium">Plan</th>
          <th className="py-1.5 px-2 text-right font-medium">Paying</th>
          <th className="py-1.5 px-2 text-right font-medium">Net / mo</th>
          <th className="py-1.5 px-2 text-right font-medium">Comped</th>
          <th className="py-1.5 px-2 text-right font-medium">Past due</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => {
          const c = plans.byPlan[b.key];
          return (
            <tr key={b.key} className="border-b border-rule">
              <td className="py-1.5 pr-4">{b.label}</td>
              <td className="py-1.5 px-2 text-right">{c.paying}</td>
              <td className="py-1.5 px-2 text-right">{usd(c.netCents)}</td>
              <td className="py-1.5 px-2 text-right">{c.comped || "·"}</td>
              <td className={`py-1.5 px-2 text-right ${c.pastDue ? "text-danger" : ""}`}>{c.pastDue || "·"}</td>
            </tr>
          );
        })}
        <tr className="font-semibold">
          <td className="py-1.5 pr-4">All plans</td>
          <td className="py-1.5 px-2 text-right">{plans.total.paying}</td>
          <td className="py-1.5 px-2 text-right">{usd(plans.total.netCents)}</td>
          <td className="py-1.5 px-2 text-right">{plans.total.comped || "·"}</td>
          <td className="py-1.5 px-2 text-right">{plans.total.pastDue || "·"}</td>
        </tr>
      </tbody>
    </table>
  );
}

function EventLine({ e }: { e: TurnoutEvent }) {
  return (
    <li className="flex items-baseline justify-between gap-3 text-sm py-0.5">
      <span className="min-w-0 truncate">
        <span className="text-muted text-xs mr-2">{dayShort(e.startAt)}</span>
        {e.url ? <Link href={e.url} className="hover:text-sage">{e.name}</Link> : e.name}
      </span>
      <span className="tabular-nums shrink-0">{e.going == null ? <span className="text-muted">?</span> : `${e.going} going`}</span>
    </li>
  );
}

export default async function ScoreboardPage() {
  if (!await requireAdmin()) redirect("/portal");
  const s = await readScoreboard(createServiceClient(), new Date(), { leaks: true });
  const { goal, pace } = s;
  const r = goal.revenue;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-forest">Scoreboard</h1>
        <p className="text-muted mt-1 text-sm">
          Members, money and the funnel, for the family meeting. Goals set 2026-11-20, due {SCOREBOARD_GOALS.goalDate}.
        </p>
      </div>

      <p className="text-sm text-muted" data-testid="actions-moved">
        What to do next ({s.actions.open.length} open) is on <Link href="/admin" className="text-sage hover:underline">Today</Link>, the admin home.
      </p>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="glass-panel">
          <CardContent className="p-5">
            <p className="text-xs text-muted">Paying members ({usd(SCOREBOARD_GOALS.minMemberCents)}+/mo plans)</p>
            <p className="text-3xl font-bold" data-testid="paying-members">
              {goal.payingMembers} <span className="text-base font-normal text-muted">of {goal.targetMembers}</span>
            </p>
            <Bar value={goal.payingMembers} goal={goal.targetMembers} marker={{ at: goal.baselineMembers, label: `Start: ${goal.baselineMembers}` }} />
            <p className="text-xs text-muted mt-3">
              {signed(goal.gained)} since {SCOREBOARD_GOALS.baselineDate} (started at {goal.baselineMembers}) ·{" "}
              {goal.membersToGo > 0 ? `${goal.membersToGo} to go` : "goal reached"}
            </p>
            <p className="text-xs text-muted mt-1" data-testid="members-pace">
              On the straight line: {pace.expectedMembers.toFixed(1)} today ·{" "}
              {pace.membersBehind > 0.05
                ? <span className="text-warn">{pace.membersBehind.toFixed(1)} behind</span>
                : <span className="text-sage">on pace</span>}
            </p>
            <p className="text-xs text-muted mt-1">
              {r.members} in good standing at any rate ({r.card} card, {r.onchain} USDC subscriptions)
              {r.pastDue.members > 0 && <span className="text-danger"> · {r.pastDue.members} past due, not counted</span>}
            </p>
            {goal.ending.members > 0 && (
              <p className="text-xs text-warn mt-1">
                {goal.ending.members} set to end with their paid period ({usd(goal.ending.netCents)}/mo), still counted
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="glass-panel">
          <CardContent className="p-5">
            <p className="text-xs text-muted">Membership revenue per month (net)</p>
            <p className="text-3xl font-bold" data-testid="revenue-net">
              {usd(r.netCents)} <span className="text-base font-normal text-muted">of {usd(goal.revenueGoalCents)}</span>
            </p>
            <Bar value={r.netCents} goal={goal.revenueGoalCents} marker={{ at: goal.rentCents, label: `Rent: ${usd(goal.rentCents)}` }} />
            <p className="text-xs text-muted mt-3">
              {usd(r.listCents)} at list ·{" "}
              {goal.rentGapCents > 0
                ? <span className="text-warn">{usd(goal.rentGapCents)} short of rent ({usd(goal.rentCents)})</span>
                : <span className="text-sage">rent ({usd(goal.rentCents)}) covered</span>}
              {" "}· {usd(goal.revenueToGoCents)} to the goal
            </p>
            <p className="text-xs text-muted mt-1">
              {goal.revenueChangeCents < 0 ? "−" : "+"}{usd(Math.abs(goal.revenueChangeCents))} since {SCOREBOARD_GOALS.baselineDate} (started at {usd(SCOREBOARD_GOALS.baselineNetCents)})
            </p>
            <p className="text-xs text-muted mt-1" data-testid="revenue-pace">
              On the straight line: {usd(pace.expectedNetCents)} today ·{" "}
              {pace.netBehindCents >= 100
                ? <span className="text-warn">{usd(pace.netBehindCents)} behind</span>
                : <span className="text-sage">on pace</span>}
            </p>
            {r.pastDue.subscriptions > 0 && (
              <p className="text-xs text-danger mt-1">{usd(r.pastDue.netCents)}/mo more is past due, not counted</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Section title="Headline" note="A few plain lines for the meeting doc.">
        <CopyTextBlock text={s.text} />
      </Section>

      <Section
        title="Where people drop off"
        note={<>From each way in to a member who keeps paying. <a href="/api/admin/scoreboard/leaks" className="text-sage hover:underline" data-testid="download-leaks-csv" download>Download CSV</a></>}
      >
        {s.leaks ? <DropOff leaks={s.leaks} /> : <p className="text-sm text-muted">Couldn&apos;t work this out right now.</p>}
      </Section>

      <Section
        title="Month by month"
        note={<>From July 2026, Denver time. <a href="/api/admin/scoreboard/months" className="text-sage hover:underline" data-testid="download-csv" download>Download CSV</a> for a sheet.</>}
      >
        <MonthByMonth rows={s.monthTable} />
        <ol className="mt-3 space-y-1 text-xs text-muted list-decimal pl-4" data-testid="month-notes">
          {MONTH_NOTES.map((n) => <li key={n}>{n}</li>)}
        </ol>
        <p className="mt-2 text-xs text-muted">{s.pool} day-pass members have never subscribed.</p>
      </Section>

      <Section title="By plan now" note="Today. All plans' paying count and revenue are the headline's.">
        <ByPlanNow plans={s.byPlanNow} />
      </Section>

      <div className="grid lg:grid-cols-2 gap-4">
        <Section title="Event turnout" note="RSVPs marked going, on Techne. Upcoming and the last 60 days.">
          {s.turnout == null ? (
            <p className="text-sm text-muted">The Techne calendar isn&apos;t configured here or couldn&apos;t be read.</p>
          ) : s.turnout.length === 0 ? (
            <p className="text-sm text-muted">No events in this window.</p>
          ) : (
            <div className="space-y-4">
              {s.turnout.map((g) => (
                <div key={g.series}>
                  <p className="text-xs font-semibold text-sage">
                    {g.series}
                    {g.past.length > 0 && <span className="text-muted font-normal"> · {g.pastGoing} going over {g.past.length} past</span>}
                  </p>
                  <ul>
                    {g.upcoming.map((e) => <EventLine key={e.uri} e={e} />)}
                    {g.upcoming.length > 0 && g.past.length > 0 && <li className="border-t border-rule my-1" />}
                    {[...g.past].reverse().map((e) => <EventLine key={e.uri} e={e} />)}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Newsletter">
          {s.newsletter.listSize == null ? (
            <p className="text-sm text-muted">Couldn&apos;t read the newsletter tables.</p>
          ) : (
            <div className="space-y-2 text-sm">
              <p><span className="text-2xl font-bold tabular-nums">{s.newsletter.listSize}</span> <span className="text-muted">on the list (members and stay-in-touch, minus unsubscribes)</span></p>
              {s.newsletter.lastIssue ? (
                <p>
                  Last issue, <Link href="/admin/mail" className="text-sage hover:underline">{s.newsletter.lastIssue.subject}</Link>{" "}
                  <span className="text-muted">({day(s.newsletter.lastIssue.createdAt)})</span>: sent to{" "}
                  <span className="font-semibold tabular-nums">{s.newsletter.lastIssue.sent}</span> of {s.newsletter.lastIssue.total}
                  {s.newsletter.lastIssue.failed > 0 && <span className="text-warn"> · {s.newsletter.lastIssue.failed} failed or skipped</span>}
                  {s.newsletter.lastIssue.pending > 0 && <span className="text-muted"> · {s.newsletter.lastIssue.pending} still sending</span>}
                </p>
              ) : (
                <p className="text-muted">No issue sent yet.</p>
              )}
            </div>
          )}
        </Section>
      </div>

      <Section
        title="People to follow up"
        note="Staff only. Shown here and nowhere else; please don't copy it into shared docs."
      >
        <div className="grid lg:grid-cols-2 gap-6">
          <div>
            <h3 className="text-xs font-semibold text-muted mb-2">
              Cancelled since {day(`${SCOREBOARD_GOALS.followUpSince}T18:00:00Z`)} ({s.canceled.length})
            </h3>
            <FollowUpTable
              rows={s.canceled.map((c) => ({
                key: `c${c.memberId}`, href: `/admin/members/${c.memberId}`, name: c.name, email: c.email,
                detail: `${planLabel(c.planKey)} · ${c.ending ? "ending, asked" : "cancelled"} ${day(c.canceledAt)}`, last: c.lastVisit ? `visited ${day(c.lastVisit)}` : "no visit in the last year",
              }))}
              empty="No cancellations since then."
            />
          </div>
          <div>
            <h3 className="text-xs font-semibold text-muted mb-2">Bought a day pass, never subscribed ({s.passBuyers.length})</h3>
            <FollowUpTable
              rows={s.passBuyers.map((b) => ({
                key: b.memberId != null ? `m${b.memberId}` : `e${b.email}`,
                href: b.memberId != null ? `/admin/members/${b.memberId}` : null,
                name: b.name ?? "(no member record)", email: b.email,
                detail: `${b.purchases} pass${b.purchases === 1 ? "" : "es"} · last bought ${day(b.lastPurchase)}`,
                last: b.lastVisit ? `visited ${day(b.lastVisit)}` : "no visit in the last year",
              }))}
              empty="No one yet."
            />
          </div>
        </div>
      </Section>

      <details data-testid="how-we-count">
        <summary className="text-xs text-muted cursor-pointer hover:text-foreground">How we count</summary>
        <p className="text-xs text-muted mt-2">
          Paying = an active or trialing subscription, either rail, counted once per member; the goal counts members whose
          plans come to {usd(SCOREBOARD_GOALS.minMemberCents)} or more a month at list price and who pay something (a promo
          code or the USDC discount doesn&apos;t take them off; a full comp isn&apos;t paying). Revenue is net of discounts (list until Stripe has synced it, never above
          list). Past due is shown apart. The dashboard, Billing and the MCP billing summary use the same definition.
        </p>
      </details>
    </div>
  );
}

function FollowUpTable({ rows, empty }: { rows: { key: string; href: string | null; name: string; email: string | null; detail: string; last: string }[]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-rule max-h-96 overflow-y-auto">
      {rows.map((r) => (
        <li key={r.key} className="py-1.5 flex items-baseline justify-between gap-3 text-sm">
          <div className="min-w-0">
            {r.href ? <Link href={r.href} className="font-medium hover:text-sage">{r.name}</Link> : <span className="font-medium">{r.name}</span>}
            {r.email && <span className="text-xs text-muted ml-2 break-all">{r.email}</span>}
            <p className="text-xs text-muted">{r.detail}</p>
          </div>
          <span className="text-xs text-muted shrink-0">{r.last}</span>
        </li>
      ))}
    </ul>
  );
}
