"use client";

import { useEffect, useState, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { Search, X } from "lucide-react";
import type { AdminUsersResponse, AdminUser } from "@/app/api/admin/users/route";
import type { Member } from "@/lib/supabase/types";

function memberStatusBadge(member: Member | null) {
  if (!member) {
    return <Badge className="text-xs bg-yellow-500/20 text-yellow-400 border-yellow-500/30">No Profile</Badge>;
  }
  if (member.disabled) {
    return <Badge variant="destructive" className="text-xs">Disabled</Badge>;
  }
  if (member.member_type === "cold_desk") {
    return <Badge className="text-xs bg-green-500/20 text-green-400 border-green-500/30">Cold Desk</Badge>;
  }
  if (member.member_type === "hot_desk") {
    return <Badge className="text-xs bg-emerald-500/20 text-emerald-400 border-emerald-500/30">Hot Desk</Badge>;
  }
  if (member.member_type === "hub_friend") {
    return <Badge className="text-xs bg-purple-500/20 text-purple-400 border-purple-500/30">Hub Friend</Badge>;
  }
  return <Badge className="text-xs bg-blue-500/20 text-blue-400 border-blue-500/30">Day Pass</Badge>;
}

// ── Mobile card view ──
function MemberCard({ name, email, badge, telegram, slot, passes, lastSignIn, action }: {
  name: React.ReactNode;
  email: string;
  badge: React.ReactNode;
  telegram: string;
  slot: string;
  passes: string;
  lastSignIn: string;
  action: React.ReactNode;
}) {
  return (
    <div className="glass-panel p-4 space-y-2 sm:hidden">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">{name}</p>
          <p className="text-xs text-muted">{email}</p>
        </div>
        {badge}
      </div>
      <div className="flex items-center gap-4 text-xs text-muted">
        {telegram !== "—" && <span>{telegram}</span>}
        {slot !== "—" && <span>Slot {slot}</span>}
        <span>{passes} passes</span>
        <span>Last: {lastSignIn}</span>
      </div>
      <div>{action}</div>
    </div>
  );
}

function AuthUserRow({ u }: { u: AdminUser }) {
  const displayName = u.member?.name ?? u.application?.name ?? null;
  const nameNode = (
    <>
      {displayName ?? <span className="text-muted italic">—</span>}
      {u.member?.is_admin && <span className="ml-2 text-xs text-gold">[Admin]</span>}
      {!u.member && u.application && (
        <span className="ml-2 text-xs text-muted italic">({u.application.membership_interest.replace(/_/g, " ")})</span>
      )}
    </>
  );
  const action = u.member ? (
    <Link href={`/admin/members/${u.member.id}`}>
      <Button variant="ghost" size="sm" className="btn-glass">Edit</Button>
    </Link>
  ) : (
    <Link href={`/admin/members/new?email=${encodeURIComponent(u.email)}&user_id=${u.authId}`}>
      <Button size="sm" className="btn-primary-glass text-xs">Create Profile</Button>
    </Link>
  );

  return (
    <>
      {/* Desktop table row */}
      <tr className="border-b border-white/5 hover:bg-white/5 transition-colors hidden sm:table-row">
        <td className="px-4 py-3 font-medium">{nameNode}</td>
        <td className="px-4 py-3 text-muted text-sm">{u.email}</td>
        <td className="px-4 py-3">{memberStatusBadge(u.member)}</td>
        <td className="px-4 py-3 text-muted text-sm">{u.member?.telegram_username ?? "—"}</td>
        <td className="px-4 py-3 text-muted font-mono text-sm">{u.member?.pin_code_slot ?? "—"}</td>
        <td className="px-4 py-3 text-muted text-sm">{u.member ? u.member.day_passes_balance : "—"}</td>
        <td className="px-4 py-3 text-muted text-xs">
          {u.lastSignIn ? new Date(u.lastSignIn).toLocaleDateString() : "Never"}
        </td>
        <td className="px-4 py-3">{action}</td>
      </tr>
      {/* Mobile card */}
      <MemberCard
        name={nameNode}
        email={u.email}
        badge={memberStatusBadge(u.member)}
        telegram={u.member?.telegram_username ?? "—"}
        slot={u.member?.pin_code_slot?.toString() ?? "—"}
        passes={u.member ? String(u.member.day_passes_balance) : "—"}
        lastSignIn={u.lastSignIn ? new Date(u.lastSignIn).toLocaleDateString() : "Never"}
        action={action}
      />
    </>
  );
}

function LegacyMemberRow({ m }: { m: Member }) {
  const nameNode = (
    <>
      {m.name}
      {m.is_admin && <span className="ml-2 text-xs text-gold">[Admin]</span>}
    </>
  );
  const action = (
    <Link href={`/admin/members/${m.id}`}>
      <Button variant="ghost" size="sm" className="btn-glass">Edit</Button>
    </Link>
  );

  return (
    <>
      <tr className="border-b border-white/5 hover:bg-white/5 transition-colors hidden sm:table-row">
        <td className="px-4 py-3 font-medium">{nameNode}</td>
        <td className="px-4 py-3 text-muted text-sm">{m.email ?? "—"}</td>
        <td className="px-4 py-3">{memberStatusBadge(m)}</td>
        <td className="px-4 py-3 text-muted text-sm">{m.telegram_username ?? "—"}</td>
        <td className="px-4 py-3 text-muted font-mono text-sm">{m.pin_code_slot ?? "—"}</td>
        <td className="px-4 py-3 text-muted text-sm">{m.day_passes_balance}</td>
        <td className="px-4 py-3 text-muted text-xs">—</td>
        <td className="px-4 py-3">{action}</td>
      </tr>
      <MemberCard
        name={nameNode}
        email={m.email ?? "—"}
        badge={memberStatusBadge(m)}
        telegram={m.telegram_username ?? "—"}
        slot={m.pin_code_slot?.toString() ?? "—"}
        passes={String(m.day_passes_balance)}
        lastSignIn="—"
        action={action}
      />
    </>
  );
}

export default function UsersPage() {
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/admin/users")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError("Failed to load users"));
  }, []);

  const noProfileCount = data?.users.filter((u) => !u.member).length ?? 0;

  // Client-side search filter
  const filteredUsers = useMemo(() => {
    if (!data || !search.trim()) return data?.users ?? [];
    const q = search.toLowerCase();
    return data.users.filter((u) => {
      const name = (u.member?.name ?? u.application?.name ?? "").toLowerCase();
      const email = u.email.toLowerCase();
      const tg = (u.member?.telegram_username ?? "").toLowerCase();
      return name.includes(q) || email.includes(q) || tg.includes(q);
    });
  }, [data, search]);

  const filteredLegacy = useMemo(() => {
    if (!data || !search.trim()) return data?.legacyMembers ?? [];
    const q = search.toLowerCase();
    return data.legacyMembers.filter((m) => {
      const name = m.name.toLowerCase();
      const email = (m.email ?? "").toLowerCase();
      const tg = (m.telegram_username ?? "").toLowerCase();
      return name.includes(q) || email.includes(q) || tg.includes(q);
    });
  }, [data, search]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
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

      {/* Search bar */}
      {data && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <Input
            placeholder="Search by name, email, or Telegram..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="glass-input pl-9 pr-8"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!data ? (
        <div className="glass-panel p-8 text-center text-muted text-sm">Loading...</div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="glass-panel overflow-hidden hidden sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-muted">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Telegram</th>
                  <th className="px-4 py-3 font-medium">Slot</th>
                  <th className="px-4 py-3 font-medium">Passes</th>
                  <th className="px-4 py-3 font-medium">Last sign-in</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((u) => (
                  <AuthUserRow key={u.authId} u={u} />
                ))}
                {filteredLegacy.map((m) => (
                  <LegacyMemberRow key={`legacy-${m.id}`} m={m} />
                ))}
              </tbody>
            </table>

            {filteredUsers.length === 0 && filteredLegacy.length === 0 && (
              <p className="text-center text-muted text-sm py-8">
                {search ? "No matching users." : "No users yet."}
              </p>
            )}
          </div>

          {/* Mobile card list */}
          <div className="space-y-3 sm:hidden">
            {filteredUsers.map((u) => (
              <AuthUserRow key={u.authId} u={u} />
            ))}
            {filteredLegacy.map((m) => (
              <LegacyMemberRow key={`legacy-${m.id}`} m={m} />
            ))}
            {filteredUsers.length === 0 && filteredLegacy.length === 0 && (
              <div className="glass-panel p-8 text-center text-muted text-sm">
                {search ? "No matching users." : "No users yet."}
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex flex-wrap gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-400/60 inline-block" />
          Cold Desk / Hot Desk — linked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-purple-400/60 inline-block" />
          Hub Friend
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-blue-400/60 inline-block" />
          Day Pass
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-yellow-400/60 inline-block" />
          No Profile — needs setup
        </span>
      </div>
    </div>
  );
}
