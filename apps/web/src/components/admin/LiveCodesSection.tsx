import { Badge } from "@/components/ui/badge";
import { RevokeCodeButton } from "@/components/admin/RevokeCodeButton";
import { QuickCodeForm } from "@/components/admin/QuickCodeForm";
import type { DayCode } from "@/lib/supabase/types";

type CodeWithMember = DayCode & {
  members: { name: string; telegram_username: string | null } | null;
};

interface Props {
  codes: CodeWithMember[];
  members: { id: number; name: string }[];
  recentInactiveCount: number;
  /** Current time on the server, used for "expiring soon" computation. */
  nowMs: number;
}

export function LiveCodesSection({ codes, members, recentInactiveCount, nowMs }: Props) {
  return (
    <div className="space-y-6">
      <QuickCodeForm members={members} />

      {!codes.length ? (
        <div className="glass-panel p-8 text-center space-y-1">
          <p className="text-muted">No active codes right now.</p>
          {recentInactiveCount > 0 && (
            <p className="text-xs text-muted">
              {recentInactiveCount} expired or revoked in the last 7 days.
            </p>
          )}
          <p className="text-xs text-muted">Issue one above ↑</p>
        </div>
      ) : (
        <>
          <div className="glass-panel overflow-x-auto hidden sm:block">
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
                    ? (expiresAt.getTime() - nowMs) < 60 * 60 * 1000
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

          <div className="space-y-3 sm:hidden">
            {codes.map((c) => {
              const expiresAt = c.expires_at ? new Date(c.expires_at) : null;
              const expiringSoon = expiresAt
                ? (expiresAt.getTime() - nowMs) < 60 * 60 * 1000
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

export type { CodeWithMember };
