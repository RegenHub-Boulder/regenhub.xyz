import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RequestDayPassButton } from "@/components/portal/RequestDayPassButton";
import { Ticket, Clock, Users } from "lucide-react";

export const metadata = { title: "Day Passes — RegenHub" };

export default async function PassesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: member } = await supabase
    .from("members")
    .select("id, name, member_type")
    .eq("email", user!.email!)
    .single();

  if (!member) return null;

  const isFullMember = member.member_type === "full";

  // Fetch day passes for this member
  const { data: passes } = await supabase
    .from("day_passes")
    .select("*")
    .eq("member_id", member.id)
    .order("created_at", { ascending: false });

  // Fetch active codes issued from this member's passes
  const passIds = passes?.map((p) => p.id) ?? [];
  const { data: activeCodes } = passIds.length > 0
    ? await supabase
        .from("day_codes")
        .select("*")
        .in("day_pass_id", passIds)
        .eq("is_active", true)
        .order("expires_at", { ascending: true })
    : { data: [] };

  const totalRemaining = passes?.reduce((sum, p) => {
    const remaining = p.allowed_uses - p.used_count;
    return sum + Math.max(0, remaining);
  }, 0) ?? 0;

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold text-forest">Day Passes</h1>
        <p className="text-muted mt-1">
          {isFullMember
            ? "Generate single-use door codes for guests"
            : "Request a door code for your visit today"}
        </p>
      </div>

      {/* Summary + action */}
      <Card className="glass-panel">
        <CardContent className="p-6">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-6">
              <div>
                <div className="flex items-center gap-2 text-sm text-muted mb-1">
                  <Ticket className="w-4 h-4" />
                  {isFullMember ? "Remaining uses" : "Passes available"}
                </div>
                <p className="text-3xl font-bold text-foreground">{totalRemaining}</p>
              </div>
              {activeCodes && activeCodes.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 text-sm text-muted mb-1">
                    <Users className="w-4 h-4" />
                    Active codes
                  </div>
                  <p className="text-3xl font-bold text-gold">{activeCodes.length}</p>
                </div>
              )}
            </div>
            <RequestDayPassButton
              memberId={member.id}
              isFullMember={isFullMember}
              remainingUses={totalRemaining}
            />
          </div>
        </CardContent>
      </Card>

      {/* Active codes */}
      {activeCodes && activeCodes.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">Active codes</h2>
          <div className="space-y-3">
            {activeCodes.map((code) => {
              const expiresAt = new Date(code.expires_at);
              const hoursLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 3600000));
              return (
                <div key={code.id} className="glass-panel p-4 flex items-center justify-between gap-4">
                  <div>
                    <p className="font-mono font-bold text-gold text-xl">{code.code}</p>
                    {code.label && <p className="text-xs text-muted mt-0.5">{code.label}</p>}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <Clock className="w-4 h-4" />
                    <span>{hoursLeft}h left</span>
                    <Badge variant="outline" className="text-xs border-white/20">
                      {expiresAt.toLocaleDateString("en-US", {
                        month: "short", day: "numeric",
                        timeZone: "America/Denver",
                      })}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Pass pools */}
      {passes && passes.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">Pass pools</h2>
          <div className="glass-panel overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-muted">
                  <th className="px-4 py-3 font-medium">Uses</th>
                  <th className="px-4 py-3 font-medium">Used</th>
                  <th className="px-4 py-3 font-medium">Remaining</th>
                  <th className="px-4 py-3 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody>
                {passes.map((p) => (
                  <tr key={p.id} className="border-b border-white/5">
                    <td className="px-4 py-3">{p.allowed_uses}</td>
                    <td className="px-4 py-3 text-muted">{p.used_count}</td>
                    <td className="px-4 py-3 font-semibold text-sage">
                      {Math.max(0, p.allowed_uses - p.used_count)}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {p.expires_at
                        ? new Date(p.expires_at).toLocaleDateString("en-US", {
                            month: "short", day: "numeric", year: "numeric",
                            timeZone: "America/Denver",
                          })
                        : "Never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(!passes || passes.length === 0) && (
        <div className="glass-panel p-8 text-center text-muted">
          <Ticket className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p>No day passes yet. Contact an admin to get set up.</p>
        </div>
      )}
    </div>
  );
}
