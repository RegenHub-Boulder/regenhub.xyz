import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LockSyncButton } from "@/components/admin/LockSyncButton";
import { Lock, CheckCircle2, XCircle, History, AlertTriangle } from "lucide-react";
import type { LockSyncResultRow } from "@/lib/supabase/types";

export const metadata = { title: "Lock Sync — Admin" };

// Total permanent-code slots available (matches DAY_CODE_SLOT_MIN - 1)
const TOTAL_SLOTS = 124;

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export default async function LockSyncPage() {
  const supabase = await createClient();

  const [{ data: members }, { data: lastRun }] = await Promise.all([
    supabase
      .from("members")
      .select("id, name, pin_code_slot, pin_code, disabled, member_type")
      .not("pin_code_slot", "is", null)
      .order("pin_code_slot", { ascending: true }),
    supabase
      .from("lock_sync_runs")
      .select("id, synced, failed, partial, results, created_at, triggered_by, members:triggered_by(name)")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const active = members?.filter((m) => !m.disabled && m.pin_code) ?? [];
  const disabledList = members?.filter((m) => m.disabled || !m.pin_code) ?? [];
  const utilizationPct = Math.round(((members?.length ?? 0) / TOTAL_SLOTS) * 100);

  // Last-sync data — typed
  type LastRun = {
    id: number;
    synced: number;
    failed: number;
    partial: number;
    results: unknown;
    created_at: string;
    triggered_by: number | null;
    members: { name: string } | null;
  };
  const last = lastRun as LastRun | null;
  const lastFailures: LockSyncResultRow[] = last
    ? (Array.isArray(last.results) ? (last.results as LockSyncResultRow[]).filter((r) => !r.ok) : [])
    : [];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-forest">Lock Sync</h1>
          <p className="text-muted mt-1">Manage slot assignments and sync codes to the Home Assistant smart lock</p>
        </div>
        <LockSyncButton />
      </div>

      {/* Last sync panel */}
      {last && (
        <Card className={`glass-panel ${last.failed > 0 ? "border border-red-500/30" : last.partial > 0 ? "border border-amber-500/30" : ""}`}>
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3">
                <History className="w-5 h-5 text-sage mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold">Last sync · {relTime(last.created_at)}</p>
                  <p className="text-xs text-muted mt-0.5">
                    {last.synced} synced
                    {last.failed > 0 && <span className="text-red-400"> · {last.failed} failed</span>}
                    {last.partial > 0 && <span className="text-amber-400"> · {last.partial} partial</span>}
                    {last.members?.name && <> · triggered by {last.members.name}</>}
                  </p>
                </div>
              </div>
            </div>
            {lastFailures.length > 0 && (
              <div className="mt-3 pt-3 border-t border-white/5">
                <p className="text-xs font-medium text-red-400 flex items-center gap-1.5 mb-2">
                  <AlertTriangle className="w-3.5 h-3.5" /> Failures
                </p>
                <ul className="text-xs space-y-1 text-muted">
                  {lastFailures.map((f, i) => (
                    <li key={i}>
                      Slot {f.slot} · {f.name} · {f.action}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted mt-2 italic">Click the Sync button above to retry.</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid sm:grid-cols-3 gap-4">
        <Card className="glass-panel">
          <CardContent className="p-5">
            <Lock className="w-5 h-5 text-sage mb-2" />
            <p className="text-sm text-muted">Slot usage</p>
            <p className="text-2xl font-bold">{members?.length ?? 0} / {TOTAL_SLOTS}</p>
            <div className="mt-2 h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div
                className={`h-full ${utilizationPct > 80 ? "bg-amber-400" : "bg-sage"}`}
                style={{ width: `${Math.min(100, utilizationPct)}%` }}
              />
            </div>
            <p className="text-xs text-muted mt-1">{utilizationPct}% utilized</p>
          </CardContent>
        </Card>
        <Card className="glass-panel">
          <CardContent className="p-5">
            <CheckCircle2 className="w-5 h-5 text-green-400 mb-2" />
            <p className="text-sm text-muted">Active codes</p>
            <p className="text-2xl font-bold text-green-400">{active.length}</p>
          </CardContent>
        </Card>
        <Card className="glass-panel">
          <CardContent className="p-5">
            <XCircle className="w-5 h-5 text-muted mb-2" />
            <p className="text-sm text-muted">Disabled / unset</p>
            <p className="text-2xl font-bold text-muted">{disabledList.length}</p>
          </CardContent>
        </Card>
      </div>

      <div className="glass-panel overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-muted">
              <th className="px-4 py-3 font-medium">Slot</th>
              <th className="px-4 py-3 font-medium">Member</th>
              <th className="px-4 py-3 font-medium">Code</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {members?.map((m) => (
              <tr key={m.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-4 py-3 font-mono text-muted">{m.pin_code_slot}</td>
                <td className="px-4 py-3 font-medium">{m.name}</td>
                <td className="px-4 py-3 font-mono text-gold">
                  {m.pin_code ?? <span className="text-muted">—</span>}
                </td>
                <td className="px-4 py-3">
                  <Badge variant="outline" className="text-xs capitalize border-white/20">
                    {m.member_type}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  {m.disabled || !m.pin_code ? (
                    <Badge variant="outline" className="text-xs border-red-500/30 text-red-400">
                      {m.disabled ? "disabled" : "no code"}
                    </Badge>
                  ) : (
                    <Badge className="text-xs bg-green-500/20 text-green-400 border-green-500/30">
                      active
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
