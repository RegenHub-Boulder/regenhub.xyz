"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import type { AdminUsersResponse, AdminUser } from "@/app/api/admin/users/route";
import type { Member } from "@/lib/supabase/types";

function memberStatusBadge(member: Member | null) {
  if (!member) {
    return <Badge className="text-xs bg-yellow-500/20 text-yellow-400 border-yellow-500/30">No Profile</Badge>;
  }
  if (member.disabled) {
    return <Badge variant="destructive" className="text-xs">Disabled</Badge>;
  }
  if (member.member_type === "full") {
    return <Badge className="text-xs bg-green-500/20 text-green-400 border-green-500/30">Full Member</Badge>;
  }
  return <Badge className="text-xs bg-blue-500/20 text-blue-400 border-blue-500/30">Day Pass</Badge>;
}

function AuthUserRow({ u }: { u: AdminUser }) {
  return (
    <tr className="border-b border-white/5 hover:bg-white/5 transition-colors">
      <td className="px-4 py-3 font-medium">
        {u.member?.name ?? <span className="text-muted italic">—</span>}
        {u.member?.is_admin && <span className="ml-2 text-xs text-gold">[Admin]</span>}
      </td>
      <td className="px-4 py-3 text-muted text-sm">{u.email}</td>
      <td className="px-4 py-3">{memberStatusBadge(u.member)}</td>
      <td className="px-4 py-3 text-muted text-sm">{u.member?.telegram_username ?? "—"}</td>
      <td className="px-4 py-3 text-muted font-mono text-sm">{u.member?.pin_code_slot ?? "—"}</td>
      <td className="px-4 py-3 text-muted text-xs">
        {u.lastSignIn ? new Date(u.lastSignIn).toLocaleDateString() : "Never"}
      </td>
      <td className="px-4 py-3">
        {u.member ? (
          <Link href={`/admin/members/${u.member.id}`}>
            <Button variant="ghost" size="sm" className="btn-glass">Edit</Button>
          </Link>
        ) : (
          <Link href={`/admin/members/new?email=${encodeURIComponent(u.email)}&user_id=${u.authId}`}>
            <Button size="sm" className="btn-primary-glass text-xs">Create Profile</Button>
          </Link>
        )}
      </td>
    </tr>
  );
}

function LegacyMemberRow({ m }: { m: Member }) {
  return (
    <tr className="border-b border-white/5 hover:bg-white/5 transition-colors opacity-70">
      <td className="px-4 py-3 font-medium">{m.name}</td>
      <td className="px-4 py-3 text-muted text-sm">{m.email ?? "—"}</td>
      <td className="px-4 py-3">
        <Badge variant="outline" className="text-xs border-white/20 text-muted">No Account</Badge>
      </td>
      <td className="px-4 py-3 text-muted text-sm">{m.telegram_username ?? "—"}</td>
      <td className="px-4 py-3 text-muted font-mono text-sm">{m.pin_code_slot ?? "—"}</td>
      <td className="px-4 py-3 text-muted text-xs">—</td>
      <td className="px-4 py-3">
        <Link href={`/admin/members/${m.id}`}>
          <Button variant="ghost" size="sm" className="btn-glass">Edit</Button>
        </Link>
      </td>
    </tr>
  );
}

export default function UsersPage() {
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/users")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError("Failed to load users"));
  }, []);

  const noProfileCount = data?.users.filter((u) => !u.member).length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-forest">Users</h1>
          {noProfileCount > 0 && (
            <p className="text-sm text-yellow-400 mt-1">
              {noProfileCount} {noProfileCount === 1 ? "person" : "people"} waiting for a profile
            </p>
          )}
        </div>
        <Link href="/admin/members/new">
          <Button className="btn-primary-glass">Add Member</Button>
        </Link>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!data ? (
        <div className="glass-panel p-8 text-center text-muted text-sm">Loading…</div>
      ) : (
        <div className="glass-panel overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-muted">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Telegram</th>
                <th className="px-4 py-3 font-medium">Slot</th>
                <th className="px-4 py-3 font-medium">Last sign-in</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <AuthUserRow key={u.authId} u={u} />
              ))}
              {data.legacyMembers.map((m) => (
                <LegacyMemberRow key={`legacy-${m.id}`} m={m} />
              ))}
            </tbody>
          </table>

          {data.users.length === 0 && data.legacyMembers.length === 0 && (
            <p className="text-center text-muted text-sm py-8">No users yet.</p>
          )}
        </div>
      )}

      <div className="flex gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-400/60 inline-block" />
          Full Member / Day Pass — linked account
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-yellow-400/60 inline-block" />
          No Profile — has account, needs setup
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-white/20 inline-block" />
          No Account — legacy / Telegram-only
        </span>
      </div>
    </div>
  );
}
