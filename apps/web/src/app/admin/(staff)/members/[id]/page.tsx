import { requireAdmin } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { redirect, notFound } from "next/navigation";
import { MemberForm } from "@/components/admin/MemberForm";
import { AddPassesCard } from "@/components/admin/AddPassesCard";
import { SubscriptionCard } from "@/components/admin/SubscriptionCard";
import { MembershipApprovalCard } from "@/components/admin/MembershipApprovalCard";
import { AdminRevokeCodeButton } from "@/components/admin/AdminRevokeCodeButton";
import { MemberDetailTabs } from "@/components/admin/MemberDetailTabs";
import { MemberActivityTimeline } from "@/components/admin/MemberActivityTimeline";
import { TechneAccountCard } from "@/components/techne/TechneAccountCard";
import { handleFor } from "@/lib/techne/did";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Key, AlertCircle, ShieldCheck, Mail, AtSign } from "lucide-react";
import { planLabel } from "@/lib/plans";
import { memberTypeLabel } from "@/lib/memberTypeLabel";
import { isLiveSubscription } from "@/lib/subscriptionStatus";
import { membershipInvoices } from "@/lib/onchain/invoiceKind";
import { effectiveMonthlyCents } from "@/lib/stripeNet";
import { readEmailHistory } from "@/lib/emailLog";
import { EmailHistory } from "@/components/admin/EmailHistory";
import { SendPaymentReminderButton } from "@/components/admin/SendPaymentReminderButton";

export const metadata = { title: "Edit Member — Admin" };

function fmtShortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default async function EditMemberPage({ params }: { params: Promise<{ id: string }> }) {
  if (!await requireAdmin()) redirect("/portal");
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: member }, { data: codeHistory }, { data: subscriptions }, { data: purchases }] = await Promise.all([
    supabase
      .from("members")
      .select("*")
      .eq("id", Number(id))
      .single(),
    supabase
      .from("day_codes")
      .select("id, code, label, pin_slot, is_active, expires_at, revoked_at, created_at")
      .eq("member_id", Number(id))
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("subscriptions")
      .select("*")
      .eq("member_id", Number(id))
      .order("created_at", { ascending: false }),
    supabase
      .from("purchases")
      .select("*")
      .eq("member_id", Number(id))
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (!member) notFound();

  const activeSubscription = subscriptions?.find((s) =>
    ["active", "trialing", "past_due"].includes(s.status),
  );

  const pastDue = activeSubscription?.status === "past_due";

  // Resolve approver names (membership + desk) for audit display
  const approverIds = [
    member.approved_for_daily_by,
    member.approved_for_full_by,
  ].filter((id): id is number => typeof id === "number");
  const uniqueApproverIds = Array.from(new Set(approverIds));
  let approverNameMap = new Map<number, string>();
  if (uniqueApproverIds.length > 0) {
    const { data: approvers } = await supabase
      .from("members")
      .select("id, name")
      .in("id", uniqueApproverIds);
    approverNameMap = new Map((approvers ?? []).map((a) => [a.id, a.name]));
  }
  const approvedByName = member.approved_for_daily_by
    ? approverNameMap.get(member.approved_for_daily_by) ?? null
    : null;
  const approvedForFullByName = member.approved_for_full_by
    ? approverNameMap.get(member.approved_for_full_by) ?? null
    : null;

  // Fetch admin_actions targeting this member (joined with actor name) for the Activity tab.
  // Service client after the page-level active-admin check above.
  const adminClient = createServiceClient();
  const [{ data: rawActions }, { data: onchainInvoices }, emailHistory] = await Promise.all([
    adminClient
      .from("admin_actions")
      .select("id, action, payload, created_at, actor_member_id")
      .eq("target_table", "members")
      .eq("target_id", String(member.id))
      .order("created_at", { ascending: false })
      .limit(50),
    // The subscription box's invoices are membership periods; USDC day passes show under purchases and activity.
    membershipInvoices((kindColumn) => {
      const query = adminClient
        .from("onchain_invoices")
        .select("id, period_start, period_end, amount_cents, status")
        .eq("member_id", member.id);
      return (kindColumn ? query.eq("kind", "membership") : query)
        .order("period_start", { ascending: false })
        .limit(6);
    }),
    readEmailHistory(adminClient, { id: member.id, email: member.email }),
  ]);
  const actorIds = Array.from(
    new Set((rawActions ?? []).map((r) => r.actor_member_id).filter((id): id is number => id != null)),
  );
  const actorNameMap = new Map<number, string>();
  if (actorIds.length > 0) {
    const { data: actors } = await adminClient.from("members").select("id, name").in("id", actorIds);
    for (const a of actors ?? []) actorNameMap.set(a.id, a.name);
  }
  const activityRows = (rawActions ?? []).map((r) => ({
    id: r.id,
    action: r.action,
    actor_name: r.actor_member_id ? actorNameMap.get(r.actor_member_id) ?? null : null,
    payload: r.payload,
    created_at: r.created_at,
  }));

  const typeLabel = memberTypeLabel(member.member_type);

  const memberTypeColor =
    member.member_type === "cold_desk" ? "bg-ok/10 text-ok border-ok/40"
    : member.member_type === "hot_desk" ? "bg-ok/10 text-ok border-ok/40"
    : member.member_type === "hub_friend" ? "bg-note/10 text-note border-note/40"
    : "bg-note/10 text-note border-note/40";

  return (
    <div className="space-y-6 max-w-3xl">
      {pastDue && (
        <div className="glass-panel panel-tone p-4 border border-danger/40 bg-danger/10 flex items-start gap-3" data-testid="past-due">
          <AlertCircle className="w-5 h-5 text-danger shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-danger">Payment past due</p>
            <p className="text-xs text-muted mt-0.5">
              {member.name}&apos;s {planLabel(activeSubscription!.plan_key)}{" "}
              {activeSubscription!.payment_rail === "onchain" ? "membership has an unpaid USDC invoice" : "subscription has a failed card payment"}
              {activeSubscription!.past_due_since && (
                <> since {fmtShortDate(activeSubscription!.past_due_since)}</>
              )}
              . After 7 days the grace period ends and they move to day passes. Emails they got are under Activity.
            </p>
          </div>
          {member.email && <SendPaymentReminderButton memberId={member.id} />}
        </div>
      )}

      {/* Header — at-a-glance status */}
      <header className="space-y-3">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <h1 className="text-3xl font-bold text-forest">{member.name}</h1>
          <div className="flex gap-2 flex-wrap text-xs text-muted">
            {member.email && (
              <span className="inline-flex items-center gap-1">
                <Mail className="w-3.5 h-3.5" />
                {member.email}
              </span>
            )}
            {member.telegram_username && (
              <span className="inline-flex items-center gap-1">
                <AtSign className="w-3.5 h-3.5" />
                {member.telegram_username}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge className={`text-xs ${memberTypeColor}`}>{typeLabel}</Badge>
          {activeSubscription && (
            <Badge className={`text-xs ${
              activeSubscription.status === "past_due"
                ? "bg-danger/10 text-danger border-danger/40"
                : "bg-sage/20 text-sage border-sage/30"
            }`}>
              ${effectiveMonthlyCents(activeSubscription) / 100}/mo {planLabel(activeSubscription.plan_key)}
              {activeSubscription.status === "past_due" && " · past due"}
              {activeSubscription.cancel_at_period_end && " · canceling"}
            </Badge>
          )}
          {member.approved_for_daily && !member.approved_for_full && !activeSubscription && (
            <Badge className="text-xs bg-ok/10 text-ok border-ok/40">
              <ShieldCheck className="w-3 h-3 mr-0.5 inline" />
              Approved (Daily)
            </Badge>
          )}
          {member.approved_for_full && !activeSubscription && (
            <Badge className="text-xs bg-gold/10 text-gold border-gold/20">
              <ShieldCheck className="w-3 h-3 mr-0.5 inline" />
              Approved (Full)
            </Badge>
          )}
          {member.disabled && (
            <Badge className="text-xs bg-danger/10 text-danger border-danger/40">Disabled</Badge>
          )}
          {member.is_admin && (
            <Badge className="text-xs bg-gold/20 text-gold border-gold/30">Admin</Badge>
          )}
          {member.is_coop_member && (
            <Badge className="text-xs bg-sage/20 text-sage border-sage/30">Co-op</Badge>
          )}
          <span className="text-xs text-muted ml-auto">
            {member.day_passes_balance} pass{member.day_passes_balance === 1 ? "" : "es"} ·
            {member.pin_code_slot ? ` slot ${member.pin_code_slot}` : " no slot"}
          </span>
        </div>
      </header>

      <MemberDetailTabs>
        {{
          overview: (
            <>
              <MemberForm member={member} />
              <MembershipApprovalCard
                memberId={member.id}
                memberName={member.name}
                memberEmail={member.email}
                approved={member.approved_for_daily}
                approvedAt={member.approved_for_daily_at}
                approvedByName={approvedByName}
                approvedForFull={member.approved_for_full}
                approvedForFullAt={member.approved_for_full_at}
                approvedForFullByName={approvedForFullByName}
                hasActiveSubscription={!!activeSubscription}
              />
            </>
          ),
          billing: (
            <>
              <SubscriptionCard
                memberId={member.id}
                memberName={member.name}
                activeSubscription={activeSubscription ?? null}
                subscription={activeSubscription ?? subscriptions?.find((s) => isLiveSubscription(s.status)) ?? subscriptions?.[0] ?? null}
                recentPurchases={purchases ?? []}
                invoices={onchainInvoices ?? []}
              />
            </>
          ),
          access: (
            <>
              <AddPassesCard memberId={member.id} initialBalance={member.day_passes_balance} />
              <TechneAccountCard
                did={member.did ?? null}
                handle={member.did ? await handleFor(member.did) : null}
                endpoint={`/api/admin/members/${member.id}/techne-unlink`}
                who={member.name}
              />
              {codeHistory && codeHistory.length > 0 ? (
                <Card className="glass-panel">
                  <CardContent className="p-6">
                    <div className="flex items-center gap-2 mb-4">
                      <Key className="w-5 h-5 text-sage" />
                      <h3 className="font-semibold">Code history</h3>
                      <span className="text-xs text-muted">Last {codeHistory.length}</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-rule text-left text-muted text-xs">
                            <th className="pb-2 pr-4 font-medium">Code</th>
                            <th className="pb-2 pr-4 font-medium">Slot</th>
                            <th className="pb-2 pr-4 font-medium">Status</th>
                            <th className="pb-2 pr-4 font-medium">Issued</th>
                            <th className="pb-2 pr-4 font-medium">Expires</th>
                            <th className="pb-2 font-medium"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {codeHistory.map((c) => (
                            <tr key={c.id} className="border-b border-rule">
                              <td className="py-2 pr-4 font-mono text-gold">{c.code}</td>
                              <td className="py-2 pr-4 text-muted">{c.pin_slot}</td>
                              <td className="py-2 pr-4">
                                {c.is_active ? (
                                  <Badge className="text-xs bg-ok/10 text-ok border-ok/40">Active</Badge>
                                ) : c.revoked_at ? (
                                  <Badge className="text-xs bg-danger/10 text-danger border-danger/40">Revoked</Badge>
                                ) : (
                                  <Badge className="text-xs bg-tint text-muted border-rule">Expired</Badge>
                                )}
                              </td>
                              <td className="py-2 pr-4 text-xs text-muted">
                                {new Date(c.created_at).toLocaleDateString("en-US", {
                                  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                                  timeZone: "America/Denver",
                                })}
                              </td>
                              <td className="py-2 pr-4 text-xs text-muted">
                                {c.expires_at
                                  ? new Date(c.expires_at).toLocaleDateString("en-US", {
                                      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                                      timeZone: "America/Denver",
                                    })
                                  : "—"
                                }
                              </td>
                              <td className="py-2 text-right">
                                {c.is_active && <AdminRevokeCodeButton codeId={c.id} label={c.code} />}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <Card className="glass-panel">
                  <CardContent className="p-6 text-center text-sm text-muted">
                    No codes issued yet.
                  </CardContent>
                </Card>
              )}
            </>
          ),
          activity: (
            <>
              <EmailHistory history={emailHistory} />
              <MemberActivityTimeline rows={activityRows} />
            </>
          ),
        }}
      </MemberDetailTabs>
    </div>
  );
}
