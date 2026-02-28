import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export default async function MembersPage() {
  const supabase = await createClient();
  const { data: members } = await supabase
    .from("members")
    .select("*")
    .order("name");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-forest">Members</h1>
        <Link href="/admin/members/new">
          <Button className="btn-primary-glass">Add Member</Button>
        </Link>
      </div>

      <div className="glass-panel overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-muted">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Telegram</th>
              <th className="px-4 py-3 font-medium">Slot</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {members?.map((m) => (
              <tr key={m.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-4 py-3 font-medium">
                  {m.name}
                  {m.is_admin && (
                    <span className="ml-2 text-xs text-gold">[Admin]</span>
                  )}
                </td>
                <td className="px-4 py-3 text-muted">{m.email ?? "—"}</td>
                <td className="px-4 py-3">
                  <Badge variant="outline" className="text-xs capitalize border-white/20">
                    {m.member_type}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-muted">{m.telegram_username ?? "—"}</td>
                <td className="px-4 py-3 text-muted font-mono">{m.pin_code_slot ?? "—"}</td>
                <td className="px-4 py-3">
                  {m.disabled ? (
                    <Badge variant="destructive" className="text-xs">Disabled</Badge>
                  ) : (
                    <Badge className="text-xs bg-green-500/20 text-green-400 border-green-500/30">Active</Badge>
                  )}
                </td>
                <td className="px-4 py-3">
                  <Link href={`/admin/members/${m.id}`}>
                    <Button variant="ghost" size="sm" className="btn-glass">Edit</Button>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
