import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import {
  DollarSign,
  Users,
  Ticket,
  AlertCircle,
  ArrowDownCircle,
  CheckCircle2,
  ShoppingBag,
  Gift,
  Activity,
} from "lucide-react";
import type { Subscription, Purchase, PassGrant, WebhookEvent } from "@/lib/supabase/types";
import { SendPaymentReminderButton } from "@/components/admin/SendPaymentReminderButton";
import { CollapsibleSection } from "@/components/admin/CollapsibleSection";

export const metadata = { title: "Billing — Admin" };

import { planLabel } from "@/lib/plans";

// Legacy plan keys not in current PLANS still need labels for historical rows
const legacyLabels: Record<string, string> = {
  social_events_1: "Social — 1 day/mo",
  social_events_5: "Social — 5 days/mo",
};
const planLabels: Record<string, string> = new Proxy({}, {
  get: (_, key: string) => legacyLabels[key] ?? planLabel(key),
});

const statusStyle: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  trialing: "bg-sky-500/20 text-sky-400 border-sky-500/30",
  past_due: "bg-red-500/20 text-red-400 border-red-500/30",
  canceled: "bg-white/10 text-muted border-white/20",
};

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/Denver",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
}

type SubWithMember = Subscription & {
  members: { id: number; name: string; email: string | null } | null;
};
type PurchaseWithMember = Purchase & {
  members: { id: number; name: string } | null;
};
type GrantWithMember = PassGrant & {
  members: { id: number; name: string } | null;
};

export default async function BillingPage() {
  const supabase = await createClient();

  // Beginning of current calendar month in UTC — close enough for "this month" display
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const [{ data: subs }, { data: purchases }, { data: thisMonthPurchases }, { data: grants }, { data: webhookEvents }] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("*, members(id, name, email)")
      .order("created_at", { ascending: false })
      .returns<SubWithMember[]>(),
    supabase
      .from("purchases")
      .select("*, members(id, name)")
      .order("created_at", { ascending: false })
      .limit(20)
      .returns<PurchaseWithMember[]>(),
    supabase
      .from("purchases")
      .select("amount_cents")
      .gte("created_at", startOfMonth.toISOString()),
    supabase
      .from("pass_grants")
      .select("*, members(id, name)")
      .order("created_at", { ascending: false })
      .limit(20)
      .returns<GrantWithMember[]>(),
    supabase
      .from("webhook_events")
      .select("*")
      .order("received_at", { ascending: false })
      .limit(30)
      .returns<WebhookEvent[]>(),
  ]);

  const allSubs = subs ?? [];
  const billingSubs = allSubs.filter((s) =>
    ["active", "trialing", "past_due"].includes(s.status),
  );
  const activeSubs = billingSubs.filter((s) => s.status !== "past_due");
  const pastDueSubs = billingSubs.filter((s) => s.status === "past_due");
  const cancelingSubs = billingSubs.filter((s) => s.cancel_at_period_end);

  const mrrCents = activeSubs.reduce((sum, s) => sum + s.monthly_cents, 0);
  const cancelingCents = cancelingSubs.reduce((sum, s) => sum + s.monthly_cents, 0);
  const mrrByPlan = activeSubs.reduce<Record<string, { count: number; cents: number }>>(
    (acc, s) => {
      const k = s.plan_key;
      if (!acc[k]) acc[k] = { count: 0, cents: 0 };
      acc[k].count += 1;
      acc[k].cents += s.monthly_cents;
      return acc;
    },
    {},
  );

  const dayPassRevenueThisMonth = (thisMonthPurchases ?? []).reduce(
    (sum, p) => sum + p.amount_cents,
    0,
  );
  const dayPassCountThisMonth = thisMonthPurchases?.length ?? 0;

  const recentPurchases = purchases ?? [];
  const recentGrants = grants ?? [];
  const events = webhookEvents ?? [];
  const failedEvents = events.filter((e) => e.status === "data_error" || e.status === "error");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-forest">Billing</h1>
        <p className="text-muted mt-1">Who&apos;s paying, what they&apos;re paying, and what needs attention</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="glass-panel">
          <CardContent className="p-5">
            <DollarSign className="w-6 h-6 text-sage mb-2" />
            <p className="text-xs text-muted mb-1">MRR</p>
            <p className="text-3xl font-bold text-foreground">{fmtMoney(mrrCents)}</p>
            <p className="text-xs text-muted mt-1">
              from {activeSubs.length} active sub{activeSubs.length === 1 ? "" : "s"}
              {cancelingCents > 0 && (
                <span className="text-amber-400"> · −{fmtMoney(cancelingCents)} pending cancel</span>
              )}
            </p>
          </CardContent>
        </Card>

        <Card className="glass-panel">
          <CardContent className="p-5">
            <Users className="w-6 h-6 text-sage mb-2" />
            <p className="text-xs text-muted mb-1">Paying members</p>
            <p className="text-3xl font-bold text-foreground">{billingSubs.length}</p>
            <p className="text-xs text-muted mt-1">
              {activeSubs.length} active · {pastDueSubs.length} past due
            </p>
          </CardContent>
        </Card>

        <Card className="glass-panel">
          <CardContent className="p-5">
            <Ticket className="w-6 h-6 text-sage mb-2" />
            <p className="text-xs text-muted mb-1">Day passes this month</p>
            <p className="text-3xl font-bold text-foreground">{fmtMoney(dayPassRevenueThisMonth)}</p>
            <p className="text-xs text-muted mt-1">
              {dayPassCountThisMonth} purchase{dayPassCountThisMonth === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>

        <Card className="glass-panel">
          <CardContent className="p-5">
            <ArrowDownCircle className="w-6 h-6 text-amber-400 mb-2" />
            <p className="text-xs text-muted mb-1">Queued to cancel</p>
            <p className="text-3xl font-bold text-foreground">{cancelingSubs.length}</p>
            <p className="text-xs text-muted mt-1">at end of current period</p>
          </CardContent>
        </Card>
      </div>

      {/* Plan composition */}
      {Object.keys(mrrByPlan).length > 0 && (
        <Card className="glass-panel">
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold mb-4">Plan composition</h3>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {Object.entries(mrrByPlan)
                .sort((a, b) => b[1].cents - a[1].cents)
                .map(([key, v]) => (
                  <div key={key} className="border-l-2 border-sage/40 pl-3">
                    <p className="text-xs text-muted">{planLabels[key] ?? key}</p>
                    <p className="text-lg font-semibold">{v.count}× · {fmtMoney(v.cents)}/mo</p>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Past-due alert section */}
      {pastDueSubs.length > 0 && (
        <Card className="glass-panel border border-red-500/30">
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold mb-4 flex items-center gap-2 text-red-400">
              <AlertCircle className="w-4 h-4" />
              Past due — needs attention
            </h3>
            <div className="space-y-2">
              {pastDueSubs.map((s) => {
                const days = daysSince(s.past_due_since);
                return (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-3 py-2 px-3 rounded hover:bg-white/5 transition-colors"
                  >
                    <Link
                      href={s.members ? `/admin/members/${s.members.id}` : "#"}
                      className="flex-1 flex items-center justify-between gap-3"
                    >
                      <div>
                        <p className="text-sm font-medium">{s.members?.name ?? "(unknown member)"}</p>
                        <p className="text-xs text-muted">{s.members?.email}</p>
                      </div>
                      <div className="text-right text-xs">
                        <p className="text-red-400">{days != null ? `${days}d past due` : "past due"}</p>
                        <p className="text-muted">
                          {planLabels[s.plan_key] ?? s.plan_key} · {fmtMoney(s.monthly_cents)}/mo
                        </p>
                      </div>
                    </Link>
                    {s.members && <SendPaymentReminderButton memberId={s.members.id} />}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Canceling section */}
      {cancelingSubs.length > 0 && (
        <Card className="glass-panel border border-amber-500/20">
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold mb-4 flex items-center gap-2 text-amber-400">
              <ArrowDownCircle className="w-4 h-4" />
              Cancellations queued
            </h3>
            <div className="space-y-2">
              {cancelingSubs.map((s) => (
                <Link
                  key={s.id}
                  href={s.members ? `/admin/members/${s.members.id}` : "#"}
                  className="flex items-center justify-between gap-3 py-2 px-3 rounded hover:bg-white/5 transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium">{s.members?.name ?? "(unknown member)"}</p>
                    <p className="text-xs text-muted">{s.members?.email}</p>
                  </div>
                  <div className="text-right text-xs">
                    <p className="text-amber-400">Ends {fmtDate(s.current_period_end)}</p>
                    <p className="text-muted">
                      {planLabels[s.plan_key] ?? s.plan_key} · {fmtMoney(s.monthly_cents)}/mo
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* All active subscriptions */}
      <Card className="glass-panel">
        <CardContent className="p-5">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-sage" />
            All subscriptions
            <span className="text-xs text-muted font-normal">({billingSubs.length})</span>
          </h3>
          {billingSubs.length === 0 ? (
            <p className="text-sm text-muted">No active subscriptions yet.</p>
          ) : (
            <>
              {/* Desktop table */}
              <div className="overflow-x-auto hidden sm:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-muted text-xs">
                      <th className="py-2 pr-4 font-medium">Member</th>
                      <th className="py-2 pr-4 font-medium">Plan</th>
                      <th className="py-2 pr-4 font-medium">Rate</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 pr-4 font-medium">Started</th>
                      <th className="py-2 pr-4 font-medium">Next renewal</th>
                      <th className="py-2 font-medium">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billingSubs
                      .sort((a, b) => b.monthly_cents - a.monthly_cents)
                      .map((s) => (
                        <tr key={s.id} className="border-b border-white/5 hover:bg-white/5">
                          <td className="py-2 pr-4">
                            {s.members ? (
                              <Link href={`/admin/members/${s.members.id}`} className="hover:text-sage">
                                <p className="font-medium">{s.members.name}</p>
                                <p className="text-xs text-muted">{s.members.email}</p>
                              </Link>
                            ) : (
                              <span className="text-muted italic">unknown</span>
                            )}
                          </td>
                          <td className="py-2 pr-4">{planLabels[s.plan_key] ?? s.plan_key}</td>
                          <td className="py-2 pr-4 font-medium">{fmtMoney(s.monthly_cents)}/mo</td>
                          <td className="py-2 pr-4">
                            <Badge className={`text-xs ${statusStyle[s.status] ?? "border-white/20"}`}>
                              {s.status}
                            </Badge>
                            {s.cancel_at_period_end && (
                              <Badge className="text-xs bg-amber-500/20 text-amber-400 border-amber-500/30 ml-1">
                                canceling
                              </Badge>
                            )}
                          </td>
                          <td className="py-2 pr-4 text-xs text-muted">{fmtDate(s.created_at)}</td>
                          <td className="py-2 pr-4 text-xs text-muted">{fmtDate(s.current_period_end)}</td>
                          <td className="py-2 text-xs text-muted">
                            {s.discount_note ?? (s.discount_cents ? `$${s.discount_cents / 100} off` : "—")}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {/* Mobile cards */}
              <div className="space-y-3 sm:hidden">
                {billingSubs
                  .sort((a, b) => b.monthly_cents - a.monthly_cents)
                  .map((s) => (
                    <Link
                      key={s.id}
                      href={s.members ? `/admin/members/${s.members.id}` : "#"}
                      className="block glass-panel p-3 space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium text-sm">{s.members?.name ?? "(unknown)"}</p>
                        <p className="font-semibold text-sm">{fmtMoney(s.monthly_cents)}/mo</p>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <Badge className={`text-xs ${statusStyle[s.status] ?? "border-white/20"}`}>{s.status}</Badge>
                        <span>·</span>
                        <span>{planLabels[s.plan_key] ?? s.plan_key}</span>
                      </div>
                      {s.discount_note && <p className="text-xs text-muted">{s.discount_note}</p>}
                    </Link>
                  ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Monthly day-pass grants — collapsed by default since it's reference data */}
      {recentGrants.length > 0 && (
        <CollapsibleSection
          title={
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Gift className="w-4 h-4 text-sage" />
              Monthly auto-grants
              <span className="text-xs text-muted font-normal">(latest {recentGrants.length})</span>
            </h3>
          }
          hint={`${recentGrants.length} grants logged`}
        >
          <p className="text-xs text-muted mb-3">
            Day passes auto-credited to social-tier members when their subscription invoice succeeds.
          </p>
          <div className="space-y-2">
            {recentGrants.map((g) => (
              <Link
                key={g.id}
                href={g.members ? `/admin/members/${g.members.id}` : "#"}
                className="flex items-center justify-between gap-3 py-2 px-3 rounded hover:bg-white/5 transition-colors"
              >
                <div>
                  <p className="text-sm font-medium">{g.members?.name ?? "(unknown)"}</p>
                  <p className="text-xs text-muted">{planLabels[g.plan_key] ?? g.plan_key}</p>
                </div>
                <div className="text-right text-xs">
                  <p className="font-medium text-sage">+{g.passes_granted} pass{g.passes_granted === 1 ? "" : "es"}</p>
                  <p className="text-muted">{fmtDate(g.created_at)}</p>
                </div>
              </Link>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Recent day-pass purchases */}
      <Card className="glass-panel">
        <CardContent className="p-5">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <ShoppingBag className="w-4 h-4 text-sage" />
            Recent day-pass purchases
            <span className="text-xs text-muted font-normal">(latest {recentPurchases.length})</span>
          </h3>
          {recentPurchases.length === 0 ? (
            <p className="text-sm text-muted">No purchases yet.</p>
          ) : (
            <div className="space-y-2">
              {recentPurchases.map((p) => (
                <Link
                  key={p.id}
                  href={p.members ? `/admin/members/${p.members.id}` : "#"}
                  className="flex items-center justify-between gap-3 py-2 px-3 rounded hover:bg-white/5 transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium">{p.members?.name ?? p.email ?? "(unknown)"}</p>
                    <p className="text-xs text-muted">
                      {p.kind === "five_pack" ? "5-Pack" : "Day Pass"} · {p.passes_granted} pass
                      {p.passes_granted === 1 ? "" : "es"}
                    </p>
                  </div>
                  <div className="text-right text-xs">
                    <p className="font-medium">{fmtMoney(p.amount_cents)}</p>
                    <p className="text-muted">{fmtDate(p.created_at)}</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stripe webhook delivery log — collapsed by default; auto-expands if failures present */}
      {events.length > 0 && (
        <CollapsibleSection
          title={
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Activity className="w-4 h-4 text-sage" />
              Stripe webhook activity
              <span className="text-xs text-muted font-normal">(last {events.length})</span>
              {failedEvents.length > 0 && (
                <Badge className="text-xs bg-amber-500/20 text-amber-400 border-amber-500/30">
                  {failedEvents.length} need attention
                </Badge>
              )}
            </h3>
          }
          hint={`${events.length} events`}
          defaultOpen={failedEvents.length > 0}
        >
          <p className="text-xs text-muted mb-3">
            Every Stripe event we receive is logged here. Failed events show up so we can investigate why a customer&apos;s subscription isn&apos;t reflecting correctly.
          </p>
          <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-left text-muted">
                    <th className="py-2 pr-3 font-medium">Event</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Member</th>
                    <th className="py-2 pr-3 font-medium">Took</th>
                    <th className="py-2 font-medium">Received</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => {
                    const statusColor =
                      e.status === "ok" ? "text-emerald-400"
                      : e.status === "processing" ? "text-sky-400"
                      : e.status === "data_error" ? "text-amber-400"
                      : "text-red-400";
                    return (
                      <tr key={e.id} className="border-b border-white/5">
                        <td className="py-2 pr-3 font-mono text-xs text-muted">{e.event_type}</td>
                        <td className="py-2 pr-3">
                          <span className={statusColor}>{e.status}</span>
                          {e.error_message && (
                            <span className="text-muted ml-1" title={e.error_message}>· {e.error_message.slice(0, 40)}{e.error_message.length > 40 ? "…" : ""}</span>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          {e.member_id ? (
                            <Link href={`/admin/members/${e.member_id}`} className="text-sage hover:underline">#{e.member_id}</Link>
                          ) : <span className="text-muted">—</span>}
                        </td>
                        <td className="py-2 pr-3 text-muted">{e.duration_ms != null ? `${e.duration_ms}ms` : "—"}</td>
                        <td className="py-2 text-muted">
                          {new Date(e.received_at).toLocaleString("en-US", {
                            timeZone: "America/Denver",
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
        </CollapsibleSection>
      )}
    </div>
  );
}
