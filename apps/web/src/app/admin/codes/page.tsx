import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { RevokeCodeButton } from "@/components/admin/RevokeCodeButton";
import { QuickCodeForm } from "@/components/admin/QuickCodeForm";
import type { DayCode } from "@/lib/supabase/types";

type CodeWithMember = DayCode & {
  members: { name: string; telegram_username: string | null } | null;
};

export default async function ActiveCodesPage() {
  const supabase = await createClient();

  const [codesResult, membersResult] = await Promise.all([
    supabase
      .from("day_codes")
      .select("*, members(name, telegram_username)")
      .eq("is_active", true)
      .order("expires_at", { ascending: true }),
    supabase
      .from("members")
      .select("id, name")
      .eq("disabled", false)
      .order("name", { ascending: true }),
  ]);

  const codes = codesResult.data as CodeWithMember[] | null;
  const members = membersResult.data;

  const now = new Date();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-forest">Live Door Codes</h1>
        <p className="text-muted text-sm">{codes?.length ?? 0} active</p>
      </div>

      <QuickCodeForm members={members ?? []} />

      {!codes?.length ? (
        <div className="glass-panel p-8 text-center text-muted">No active codes right now.</div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="glass-panel overflow-hidden hidden sm:block">
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
                  const expiresAt = c.expires_at ? new Date(c.expires_at) : null;
                  const expiringSoon = expiresAt
                    ? (expiresAt.getTime() - now.getTime()) < 60 * 60 * 1000
                    : false;
                  const member = c.members;
                  return (
                    <tr key={c.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      <td className="px-4 py-3 font-mono font-bold text-gold">{c.code}</td>
                      <td className="px-4 py-3 text-muted">{c.pin_slot}</td>
                      <td className="px-4 py-3">
                        {c.label ?? member?.name ?? <span className="text-muted">anonymous</span>}
                      </td>
                      <td className="px-4 py-3">
                        {expiresAt ? (
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
                        ) : (
                          <span className="text-xs text-muted">No expiry</span>
                        )}
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

          {/* Mobile card list */}
          <div className="space-y-3 sm:hidden">
            {codes.map((c) => {
              const expiresAt = c.expires_at ? new Date(c.expires_at) : null;
              const expiringSoon = expiresAt
                ? (expiresAt.getTime() - now.getTime()) < 60 * 60 * 1000
                : false;
              const member = c.members;
              return (
                <div key={c.id} className="glass-panel p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-mono font-bold text-gold text-xl">{c.code}</p>
                      <p className="text-xs text-muted mt-0.5">
                        Slot {c.pin_slot} · {c.label ?? member?.name ?? "anonymous"}
                      </p>
                    </div>
                    <RevokeCodeButton codeId={c.id} code={c.code} />
                  </div>
                  <div className="mt-2">
                    {expiresAt ? (
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
                    ) : (
                      <span className="text-xs text-muted">No expiry</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
