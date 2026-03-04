import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RequestDayPassButton } from "@/components/portal/RequestDayPassButton";
import { RevokeCodeButton } from "@/components/portal/RevokeCodeButton";
import { Ticket, Clock } from "lucide-react";

export const metadata = { title: "Live Codes — RegenHub" };

export default async function PassesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: member } = await supabase
    .from("members")
    .select("id, name, member_type, day_passes_balance")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member) return null;

  const { data: activeCodes } = await supabase
    .from("day_codes")
    .select("*")
    .eq("member_id", member.id)
    .eq("is_active", true)
    .order("expires_at", { ascending: true, nullsFirst: false });

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold text-forest">Live Codes</h1>
        <p className="text-muted mt-1">Generate temporary door codes for guests or your own use</p>
      </div>

      {/* Balance + action */}
      <Card className="glass-panel">
        <CardContent className="p-6">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 text-sm text-muted mb-1">
                <Ticket className="w-4 h-4" />
                Passes remaining
              </div>
              <p className={`text-4xl font-bold ${member.day_passes_balance > 0 ? "text-gold" : "text-muted"}`}>
                {member.day_passes_balance}
              </p>
            </div>
            <RequestDayPassButton
              memberId={member.id}
              isFullMember={member.member_type !== "day_pass"}
              remainingUses={member.day_passes_balance}
            />
          </div>
          {member.day_passes_balance === 0 && (
            <p className="text-sm text-muted mt-4">No passes remaining — contact an admin to top up.</p>
          )}
        </CardContent>
      </Card>

      {/* Active codes */}
      {activeCodes && activeCodes.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">Active codes</h2>
          <div className="space-y-3">
            {activeCodes.map((code) => {
              const expiresAt = code.expires_at ? new Date(code.expires_at) : null;
              const msLeft = expiresAt ? expiresAt.getTime() - Date.now() : null;
              const hoursLeft = msLeft != null ? Math.max(0, Math.ceil(msLeft / 3600000)) : null;
              const timeLabel = hoursLeft == null
                ? null
                : hoursLeft < 24 ? `${hoursLeft}h left` : `${Math.ceil(hoursLeft / 24)}d left`;

              return (
                <div key={code.id} className="glass-panel p-4 flex items-center justify-between gap-4">
                  <div>
                    <p className="font-mono font-bold text-gold text-xl">{code.code}</p>
                    {code.label && <p className="text-xs text-muted mt-0.5">{code.label}</p>}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 text-sm text-muted">
                      <Clock className="w-4 h-4" />
                      {timeLabel != null ? (
                        <>
                          <span>{timeLabel}</span>
                          <Badge variant="outline" className="text-xs border-white/20">
                            {expiresAt!.toLocaleDateString("en-US", {
                              month: "short", day: "numeric",
                              timeZone: "America/Denver",
                            })}
                          </Badge>
                        </>
                      ) : (
                        <span>No expiry</span>
                      )}
                    </div>
                    <RevokeCodeButton codeId={code.id} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(!activeCodes || activeCodes.length === 0) && (
        <div className="glass-panel p-8 text-center text-muted">
          <Ticket className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p>No active codes. Generate one above.</p>
        </div>
      )}
    </div>
  );
}
