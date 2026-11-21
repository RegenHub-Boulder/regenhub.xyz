import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { NextActions, type NextAction } from "@/components/admin/NextActions";
import { readScoreboard } from "@/lib/scoreboardData";
import { ACTION_RULES, type RecommendedAction } from "@/lib/scoreboardActions";
import { SCOREBOARD_TZ, usd } from "@/lib/scoreboard";
import { adminQueue } from "@/lib/adminQueue";

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

  const [s, apps, freeDays, desks, live, lastSync, quarantine] = await Promise.all([
    readScoreboard(admin),
    admin.from("applications").select("id", { count: "exact", head: true }).eq("status", "pending"),
    admin.from("free_day_claims").select("id", { count: "exact", head: true }).eq("status", "pending"),
    admin.from("members").select("id").eq("disabled", false).in("member_type", ["cold_desk", "hot_desk"]),
    admin.from("subscriptions").select("member_id").in("status", ["active", "trialing", "past_due"]),
    admin.from("lock_sync_runs").select("failed").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("lock_slot_quarantine").select("slot", { count: "exact", head: true }),
  ]);
  const billed = new Set((live.data ?? []).map((r) => r.member_id));
  const queue = adminQueue({
    pendingApplications: apps.count ?? 0,
    pendingFreeDays: freeDays.count ?? 0,
    unbilledDesks: (desks.data ?? []).filter((m) => !billed.has(m.id)).length,
    lastSyncFailures: (lastSync.data as { failed: number | null } | null)?.failed ?? 0,
    quarantinedSlots: quarantine.count ?? 0,
  });
  const { goal } = s;
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: SCOREBOARD_TZ });

  return (
    <div className="max-w-3xl space-y-10">
      <header>
        <h1 className="text-3xl font-bold text-forest">Today</h1>
        <p className="text-sm text-muted mt-2" data-testid="admin-goals">
          {today} · <span className="text-foreground">{goal.payingMembers} of {goal.targetMembers}</span> paying members ·{" "}
          <span className="text-foreground">{usd(goal.revenue.netCents)} of {usd(goal.revenueGoalCents)}</span> a month ·{" "}
          <Link href="/admin/scoreboard" className="text-sage hover:underline">Scoreboard →</Link>
        </p>
      </header>

      <section aria-labelledby="waiting" data-testid="admin-waiting">
        <h2 id="waiting" className="text-sm font-semibold mb-3">Waiting on you</h2>
        {queue.length === 0 ? (
          <p className="text-sm text-muted">Nothing waiting.</p>
        ) : (
          <ul className="divide-y divide-white/5 border-y border-white/5">
            {queue.map((q) => (
              <li key={q.key}>
                <Link href={q.href} className="flex items-center gap-3 py-2.5 text-sm hover:text-sage">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${q.urgent ? "bg-red-400" : "bg-amber-400"}`} />
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
        <NextActions
          open={s.actions.open.map(forList)}
          hidden={s.actions.hidden.map((a) => ({ ...forList(a), mark: a.mark.state }))}
          top={ACTION_RULES.showTop}
        />
      </section>

      <nav aria-label="Shortcuts" className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted border-t border-white/5 pt-4">
        <Link href="/admin/access?tab=codes" className="hover:text-foreground">Quick door code</Link>
        <Link href="/admin/members" className="hover:text-foreground">Find a member</Link>
        <Link href="/admin/members/new" className="hover:text-foreground">Add a member</Link>
      </nav>
    </div>
  );
}
