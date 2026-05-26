import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { MemberForm } from "@/components/admin/MemberForm";
import { AddPassesCard } from "@/components/admin/AddPassesCard";
import { SubscriptionCard } from "@/components/admin/SubscriptionCard";
import { MembershipApprovalCard } from "@/components/admin/MembershipApprovalCard";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Key, AlertCircle } from "lucide-react";

export const metadata = { title: "Edit Member — Admin" };

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

  return (
    <div className="space-y-8 max-w-2xl">
      {pastDue && (
        <div className="glass-panel p-4 border border-red-500/40 bg-red-500/5 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-400">Payment past due</p>
            <p className="text-xs text-muted mt-0.5">
              {member.name}&apos;s {activeSubscription!.plan_key} subscription has a failed payment
              {activeSubscription!.past_due_since && (
                <> since {new Date(activeSubscription!.past_due_since).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</>
              )}
              . The 7-day grace cron will flip them to day-pass if not resolved.
            </p>
          </div>
        </div>
      )}

      <div>
        <h1 className="text-3xl font-bold text-forest">Edit Member</h1>
        <p className="text-muted mt-1">{member.name}</p>
      </div>
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
      <SubscriptionCard
        memberId={member.id}
        memberName={member.name}
        activeSubscription={activeSubscription ?? null}
        recentPurchases={purchases ?? []}
      />
      <AddPassesCard memberId={member.id} initialBalance={member.day_passes_balance} />

      {/* Code history */}
      {codeHistory && codeHistory.length > 0 && (
        <Card className="glass-panel">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <Key className="w-5 h-5 text-sage" />
              <h3 className="font-semibold">Code History</h3>
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
                    <th className="pb-2 font-medium">Expires</th>
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
                      <td className="py-2 text-xs text-muted">
                        {c.expires_at
                          ? new Date(c.expires_at).toLocaleDateString("en-US", {
                              month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                              timeZone: "America/Denver",
                            })
                          : "—"
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
