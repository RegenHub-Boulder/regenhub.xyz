import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { CopyTextBlock } from "@/components/admin/CopyTextBlock";
import { planLabel } from "@/lib/plans";
import { SCOREBOARD_GOALS, SCOREBOARD_TZ, usd, type MonthFlow, type TurnoutEvent } from "@/lib/scoreboard";
import { readScoreboard } from "@/lib/scoreboardData";

export const metadata = { title: "Scoreboard — Admin" };
export const dynamic = "force-dynamic";

const monthShort = (key: string) =>
  new Date(`${key}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
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
    <div className="relative h-2 rounded-full bg-white/10 mt-3">
      <div className="absolute inset-y-0 left-0 rounded-full bg-sage" style={{ width: `${pct(value, goal)}%` }} />
      {marker && (
        <div className="absolute -top-1 -bottom-1 w-px bg-gold" style={{ left: `${pct(marker.at, goal)}%` }} title={marker.label} />
      )}
    </div>
  );
}

function MonthTable({ months, rows }: { months: string[]; rows: { label: string; values: (string | number)[]; strong?: boolean; sub?: boolean }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-xs text-muted border-b border-white/10">
            <th className="py-1.5 pr-4 text-left font-medium" />
            {months.map((m) => <th key={m} className="py-1.5 px-2 text-right font-medium">{monthShort(m)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={`border-b border-white/5 ${r.sub ? "text-xs text-muted" : ""}`}>
              <td className={`py-1.5 pr-4 ${r.sub ? "pl-3" : ""} ${r.strong ? "font-semibold" : ""}`}>{r.label}</td>
              {r.values.map((v, i) => (
                <td key={months[i]} className={`py-1.5 px-2 text-right ${r.strong ? "font-semibold" : ""}`}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function planRows(flow: MonthFlow[]) {
  const plans = [...new Set(flow.flatMap((m) => Object.keys(m.byPlan)))].sort((a, b) => planLabel(a).localeCompare(planLabel(b)));
  return plans.map((p) => ({
    label: planLabel(p),
    sub: true,
    values: flow.map((m) => {
      const v = m.byPlan[p];
      if (!v || (v.started === 0 && v.canceled === 0)) return "·";
      return [v.started ? `+${v.started}` : "", v.canceled ? `−${v.canceled}` : ""].filter(Boolean).join(" ");
    }),
  }));
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
  const s = await readScoreboard(createServiceClient());
  const { goal, flow, funnel, pace } = s;
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
                ? <span className="text-amber-400">{pace.membersBehind.toFixed(1)} behind</span>
                : <span className="text-sage">on pace</span>}
            </p>
            <p className="text-xs text-muted mt-1">
              {r.members} in good standing at any rate ({r.card} card, {r.onchain} USDC subscriptions)
              {r.pastDue.members > 0 && <span className="text-red-400"> · {r.pastDue.members} past due, not counted</span>}
            </p>
            {goal.ending.members > 0 && (
              <p className="text-xs text-amber-400 mt-1">
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
                ? <span className="text-amber-400">{usd(goal.rentGapCents)} short of rent ({usd(goal.rentCents)})</span>
                : <span className="text-sage">rent ({usd(goal.rentCents)}) covered</span>}
              {" "}· {usd(goal.revenueToGoCents)} to the goal
            </p>
            <p className="text-xs text-muted mt-1">
              {goal.revenueChangeCents < 0 ? "−" : "+"}{usd(Math.abs(goal.revenueChangeCents))} since {SCOREBOARD_GOALS.baselineDate} (started at {usd(SCOREBOARD_GOALS.baselineNetCents)})
            </p>
            <p className="text-xs text-muted mt-1" data-testid="revenue-pace">
              On the straight line: {usd(pace.expectedNetCents)} today ·{" "}
              {pace.netBehindCents >= 100
                ? <span className="text-amber-400">{usd(pace.netBehindCents)} behind</span>
                : <span className="text-sage">on pace</span>}
            </p>
            {r.pastDue.subscriptions > 0 && (
              <p className="text-xs text-red-400 mt-1">{usd(r.pastDue.netCents)}/mo more is past due, not counted</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Section title="Headline" note="A few plain lines for the meeting doc.">
        <CopyTextBlock text={s.text} />
      </Section>

      <Section title="Subscriptions per month" note="Card and USDC. A cancellation counts in the month it ended; one asked for but still running is under People to follow up.">
        <MonthTable
          months={s.months}
          rows={[
            { label: "New", values: flow.map((m) => m.started) },
            { label: "Cancelled", values: flow.map((m) => m.canceled) },
            { label: "Net change", values: flow.map((m) => signed(m.net)), strong: true },
            ...planRows(flow),
          ]}
        />
      </Section>

      <Section title="Funnel per month" note={`${s.pool} day-pass members have never subscribed.`}>
        <MonthTable
          months={s.months}
          rows={[
            { label: "Stay-in-touch signups", values: funnel.map((m) => m.signups) },
            { label: "Applications", values: funnel.map((m) => m.applications) },
            { label: "Day passes bought", values: funnel.map((m) => m.passesBought) },
            { label: "First subscriptions", values: funnel.map((m) => m.firstSubscriptions), strong: true },
            { label: "Followed up after a night", values: s.followUps ? s.followUps.map((m) => m.followedUp) : s.months.map(() => "—") },
            { label: "→ joined within 30 days", values: s.followUps ? s.followUps.map((m) => m.joined) : s.months.map(() => "—"), sub: true },
          ]}
        />
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
                    {g.upcoming.length > 0 && g.past.length > 0 && <li className="border-t border-white/5 my-1" />}
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
                  {s.newsletter.lastIssue.failed > 0 && <span className="text-amber-400"> · {s.newsletter.lastIssue.failed} failed or skipped</span>}
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
    <ul className="divide-y divide-white/5 max-h-96 overflow-y-auto">
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
