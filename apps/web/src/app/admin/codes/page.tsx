import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { RevokeCodeButton } from "@/components/admin/RevokeCodeButton";
import type { DayCode } from "@/lib/supabase/types";

type CodeWithMember = DayCode & {
  members: { name: string; telegram_username: string | null } | null;
};

export default async function ActiveCodesPage() {
  const supabase = await createClient();

  const { data: codes } = await supabase
    .from("day_codes")
    .select("*, members(name, telegram_username)")
    .eq("is_active", true)
    .order("expires_at", { ascending: true }) as { data: CodeWithMember[] | null };

  const now = new Date();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-forest">Live Door Codes</h1>
        <p className="text-muted text-sm">{codes?.length ?? 0} active</p>
      </div>

      {!codes?.length ? (
        <div className="glass-panel p-8 text-center text-muted">No active codes right now.</div>
      ) : (
        <div className="glass-panel overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-muted">
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Slot</th>
                <th className="px-4 py-3 font-medium">Label / Member</th>
                <th className="px-4 py-3 font-medium">Expires</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => {
                const expiresAt = new Date(c.expires_at);
                const expiringSoon = (expiresAt.getTime() - now.getTime()) < 60 * 60 * 1000;
                const member = c.members;
                return (
                  <tr key={c.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <td className="px-4 py-3 font-mono font-bold text-gold">{c.code}</td>
                    <td className="px-4 py-3 text-muted">{c.pin_slot}</td>
                    <td className="px-4 py-3">
                      {c.label ?? member?.name ?? <span className="text-muted">anonymous</span>}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant="outline"
                        className={`text-xs ${expiringSoon ? "border-orange-400/50 text-orange-400" : "border-white/20 text-muted"}`}
                      >
                        {expiresAt.toLocaleString("en-US", {
                          timeZone: "America/Denver",
                          month: "short", day: "numeric",
                          hour: "numeric", minute: "2-digit", hour12: true,
                        })}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <RevokeCodeButton codeId={c.id} code={c.code} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
