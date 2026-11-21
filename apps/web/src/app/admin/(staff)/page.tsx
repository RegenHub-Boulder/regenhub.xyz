import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { NextActions, type NextAction } from "@/components/admin/NextActions";
import { readScoreboard } from "@/lib/scoreboardData";
import { ACTION_RULES, type RecommendedAction } from "@/lib/scoreboardActions";
import { SCOREBOARD_TZ, usd } from "@/lib/scoreboard";
import { adminQueue } from "@/lib/adminQueue";
import { readAll } from "@/lib/supabase/readAll";
import { BILLED_STATUSES } from "@/lib/membershipRevenue";

export const metadata = { title: "Today — Admin" };
export const dynamic = "force-dynamic";

const forList = (a: RecommendedAction & { rank: number }): NextAction => ({
  id: a.id, rank: a.rank, kind: a.kind, who: a.who, href: a.href, reason: a.reason, step: a.step, quick: a.quick, contact: a.contact ?? null,
  priority: a.priority, fingerprint: a.fingerprint,
});

/**
 * The admin home (T-482): what an admin came for, in order. What's waiting on them (queues to clear), then the people
 * to talk to ("What to do next", the scoreboard's recommended actions), with the two goal numbers in one line above.
 * The numbers in full are on /admin/scoreboard; members, billing and the door each have their own page.
 */
export default async function AdminHome() {
  if (!await requireAdmin()) redirect("/portal");
  const admin = createServiceClient();

  // The queue reads stand alone: if the scoreboard can't be read, what's waiting still shows (and the other way round).
  const count = (r: { count: number | null; error: unknown }) => (r.error ? null : r.count ?? 0);
  const settle = <T,>(label: string, p: PromiseLike<T>) => Promise.resolve(p).then((v) => v, (err) => {
    console.error(`[admin home] ${label} read failed:`, err);
    return null;
  });
  const [s, apps, freeDays, desks, live, lastSync, quarantine] = await Promise.all([
    settle("scoreboard", readScoreboard(admin)),
    admin.from("applications").select("id", { count: "exact", head: true }).eq("status", "pending"),
    admin.from("free_day_claims").select("id", { count: "exact", head: true }).eq("status", "pending"),
    settle("desk members", readAll<{ id: number }>("desk members", (from, to) => admin.from("members").select("id")
      .eq("disabled", false).in("member_type", ["cold_desk", "hot_desk"]).order("id").range(from, to))),
    settle("billed subscriptions", readAll<{ member_id: number; status: string }>("billed subscriptions", (from, to) => admin.from("subscriptions")
      .select("member_id, status").in("status", [...BILLED_STATUSES]).order("id").range(from, to))),
    admin.from("lock_sync_runs").select("failed").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("lock_slot_quarantine").select("slot", { count: "exact", head: true }),
  ]);
  const billed = live && new Set(live.map((r) => r.member_id));
  const queue = adminQueue({
    lastSyncFailures: lastSync.error ? null : (lastSync.data as { failed: number | null } | null)?.failed ?? 0,
    quarantinedSlots: count(quarantine),
    // Counted as /admin/billing lists them (the page it links to): every past-due subscription.
    pastDue: live && live.filter((r) => r.status === "past_due").length,
    pendingApplications: count(apps),
    pendingFreeDays: count(freeDays),
    unbilledDesks: desks && billed ? desks.filter((m) => !billed.has(m.id)).length : null,
  });
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: SCOREBOARD_TZ });

  return (
    <div className="max-w-3xl space-y-10">
      <header>
        <h1 className="text-3xl font-bold text-forest">Today</h1>
        <p className="text-sm text-muted mt-2" data-testid="admin-goals">
          {today} ·{" "}
          {s ? (
            <>
              <span className="text-foreground">{s.goal.payingMembers} of {s.goal.targetMembers}</span> paying members ·{" "}
              <span className="text-foreground">{usd(s.goal.revenue.netCents)} of {usd(s.goal.revenueGoalCents)}</span> a month ·{" "}
            </>
          ) : null}
          <Link href="/admin/scoreboard" className="text-sage hover:underline">Scoreboard →</Link>
        </p>
      </header>

      <section aria-labelledby="waiting" data-testid="admin-waiting">
        <h2 id="waiting" className="text-sm font-semibold mb-3">Waiting on you</h2>
        {queue.length === 0 ? (
          <p className="text-sm text-muted">Nothing waiting.</p>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {queue.map((q) => (
              <li key={q.key}>
                <Link href={q.href} className="flex items-center gap-3 py-2.5 text-sm hover:text-sage">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${q.urgent ? "bg-danger" : "bg-warn"}`} />
                  <span className="flex-1">{q.label}</span>
                  <span className="text-muted">→</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="next" data-testid="admin-next">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
          <h2 id="next" className="text-sm font-semibold">What to do next</h2>
          <p className="text-xs text-muted">
            People to talk to, ranked by what it does for the goals. Done hides one until its facts change; Not now, {ACTION_RULES.notNowDays} days.
          </p>
        </div>
        {s ? (
          <NextActions
            open={s.actions.open.map(forList)}
            hidden={s.actions.hidden.map((a) => ({ ...forList(a), mark: a.mark.state }))}
            top={ACTION_RULES.showTop}
          />
        ) : (
          <p className="text-sm text-danger">Couldn&apos;t read the scoreboard just now, so there&apos;s no list. Reload in a minute.</p>
        )}
      </section>

      <nav aria-label="Shortcuts" className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted border-t border-rule pt-4">
        <Link href="/admin/access?tab=codes" className="hover:text-foreground">Quick door code</Link>
        <Link href="/admin/members" className="hover:text-foreground">Find a member</Link>
        <Link href="/admin/members/new" className="hover:text-foreground">Add a member</Link>
      </nav>
    </div>
  );
}
