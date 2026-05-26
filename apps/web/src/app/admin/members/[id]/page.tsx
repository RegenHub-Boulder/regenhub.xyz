import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { MemberForm } from "@/components/admin/MemberForm";
import { AddPassesCard } from "@/components/admin/AddPassesCard";
import { SubscriptionCard } from "@/components/admin/SubscriptionCard";
import { MembershipApprovalCard } from "@/components/admin/MembershipApprovalCard";
import { AdminRevokeCodeButton } from "@/components/admin/AdminRevokeCodeButton";
import { MemberDetailTabs } from "@/components/admin/MemberDetailTabs";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Key, AlertCircle, ShieldCheck, Mail, AtSign } from "lucide-react";
import { planLabel } from "@/lib/plans";

export const metadata = { title: "Edit Member — Admin" };

function fmtShortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default async function EditMemberPage({ params }: { params: Promise<{ id: string }> }) {
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

  // Resolve the admin who approved this member for membership (if any) for audit display
  let approvedByName: string | null = null;
  if (member.approved_for_membership_by) {
    const { data: approver } = await supabase
      .from("members")
      .select("name")
      .eq("id", member.approved_for_membership_by)
      .maybeSingle();
    approvedByName = approver?.name ?? null;
  }

  const memberTypeLabel =
    member.member_type === "cold_desk" ? "Cold Desk"
    : member.member_type === "hot_desk" ? "Hot Desk"
    : member.member_type === "hub_friend" ? "Hub Friend"
    : "Day Pass";

  const memberTypeColor =
    member.member_type === "cold_desk" ? "bg-green-500/20 text-green-400 border-green-500/30"
    : member.member_type === "hot_desk" ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
    : member.member_type === "hub_friend" ? "bg-purple-500/20 text-purple-400 border-purple-500/30"
    : "bg-blue-500/20 text-blue-400 border-blue-500/30";

  return (
    <div className="space-y-6 max-w-3xl">
      {pastDue && (
        <div className="glass-panel p-4 border border-red-500/40 bg-red-500/5 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-400">Payment past due</p>
            <p className="text-xs text-muted mt-0.5">
              {member.name}&apos;s {planLabel(activeSubscription!.plan_key)} subscription has a failed payment
              {activeSubscription!.past_due_since && (
                <> since {fmtShortDate(activeSubscription!.past_due_since)}</>
              )}
              . The 7-day grace cron will flip them to day-pass if not resolved.
            </p>
          </div>
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
          <Badge className={`text-xs ${memberTypeColor}`}>{memberTypeLabel}</Badge>
          {activeSubscription && (
            <Badge className={`text-xs ${
              activeSubscription.status === "past_due"
                ? "bg-red-500/20 text-red-400 border-red-500/30"
                : "bg-sage/20 text-sage border-sage/30"
            }`}>
              ${activeSubscription.monthly_cents / 100}/mo {planLabel(activeSubscription.plan_key)}
              {activeSubscription.status === "past_due" && " · past due"}
              {activeSubscription.cancel_at_period_end && " · canceling"}
            </Badge>
          )}
          {member.approved_for_membership && !activeSubscription && (
            <Badge className="text-xs bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
              <ShieldCheck className="w-3 h-3 mr-0.5 inline" />
              Approved to subscribe
            </Badge>
          )}
          {member.disabled && (
            <Badge className="text-xs bg-red-500/20 text-red-400 border-red-500/30">Disabled</Badge>
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
                approved={member.approved_for_membership}
                approvedAt={member.approved_for_membership_at}
                approvedByName={approvedByName}
                hasActiveSubscription={!!activeSubscription}
              />
            </>
          ),
          billing: (
            <SubscriptionCard
              memberId={member.id}
              memberName={member.name}
              activeSubscription={activeSubscription ?? null}
              recentPurchases={purchases ?? []}
            />
          ),
          access: (
            <>
              <AddPassesCard memberId={member.id} initialBalance={member.day_passes_balance} />
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
                          <tr className="border-b border-white/10 text-left text-muted text-xs">
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
                            <tr key={c.id} className="border-b border-white/5">
                              <td className="py-2 pr-4 font-mono text-gold">{c.code}</td>
                              <td className="py-2 pr-4 text-muted">{c.pin_slot}</td>
                              <td className="py-2 pr-4">
                                {c.is_active ? (
                                  <Badge className="text-xs bg-emerald-500/20 text-emerald-400 border-emerald-500/30">Active</Badge>
                                ) : c.revoked_at ? (
                                  <Badge className="text-xs bg-red-500/20 text-red-400 border-red-500/30">Revoked</Badge>
                                ) : (
                                  <Badge className="text-xs bg-white/10 text-muted border-white/20">Expired</Badge>
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
        }}
      </MemberDetailTabs>
    </div>
  );
}
