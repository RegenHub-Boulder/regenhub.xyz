import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LockSyncButton } from "@/components/admin/LockSyncButton";
import { Lock, CheckCircle2, XCircle } from "lucide-react";

export const metadata = { title: "Lock Sync — Admin" };

export default async function LockSyncPage() {
  const supabase = await createClient();

  const { data: members } = await supabase
    .from("members")
    .select("id, name, pin_code_slot, pin_code, disabled, member_type")
    .not("pin_code_slot", "is", null)
    .order("pin_code_slot", { ascending: true });

  const active = members?.filter((m) => !m.disabled && m.pin_code) ?? [];
  const disabled = members?.filter((m) => m.disabled || !m.pin_code) ?? [];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-forest">Lock Sync</h1>
          <p className="text-muted mt-1">Manage slot assignments and sync codes to the Home Assistant smart lock</p>
        </div>
        <LockSyncButton />
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <Card className="glass-panel">
          <CardContent className="p-5">
            <Lock className="w-5 h-5 text-sage mb-2" />
            <p className="text-sm text-muted">Total slots</p>
            <p className="text-2xl font-bold">{members?.length ?? 0} / 249</p>
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
            <p className="text-2xl font-bold text-muted">{disabled.length}</p>
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
