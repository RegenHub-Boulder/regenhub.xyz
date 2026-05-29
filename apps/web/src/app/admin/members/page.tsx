"use client";

import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { Search, X } from "lucide-react";
import type { AdminUsersResponse, AdminUser, AdminUserSubscription } from "@/app/api/admin/users/route";
import type { Member } from "@/lib/supabase/types";

function subBadge(sub: AdminUserSubscription | null) {
  if (!sub) return null;
  const dollars = `$${(sub.monthly_cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}/mo`;
  if (sub.status === "past_due") {
    return (
      <Badge className="text-sm bg-red-500/20 text-red-400 border-red-500/30" title="Payment failed">
        {dollars} · past due
      </Badge>
    );
  }
  if (sub.cancel_at_period_end) {
    return (
      <Badge className="text-sm bg-amber-500/20 text-amber-400 border-amber-500/30" title="Cancelling at period end">
        {dollars} · canceling
      </Badge>
    );
  }
  return (
    <Badge className="text-sm bg-sage/20 text-sage border-sage/30" title="Active subscription">
      {dollars}
    </Badge>
  );
}

/** Member is approved to subscribe but hasn't yet — distinct from active subscriber. */
function approvalBadge(approved: boolean | undefined, hasSub: boolean) {
  if (hasSub || !approved) return null;
  return (
    <Badge
      className="text-sm bg-sage/10 text-sage border-sage/30"
      title="Approved to subscribe (hasn't yet)"
    >
      ✓ Approved
    </Badge>
  );
}

type LegacyMemberWithSub = Member & { subscription: AdminUserSubscription | null };

function memberStatusBadge(member: Member | null) {
  if (!member) {
    return <Badge className="text-sm bg-yellow-500/20 text-yellow-400 border-yellow-500/30">No Profile</Badge>;
  }
  if (member.disabled) {
    return <Badge variant="destructive" className="text-sm">Disabled</Badge>;
  }
  if (member.member_type === "cold_desk") {
    return <Badge className="text-sm bg-green-500/20 text-green-400 border-green-500/30">Cold Desk</Badge>;
  }
  if (member.member_type === "hot_desk") {
    return <Badge className="text-sm bg-emerald-500/20 text-emerald-400 border-emerald-500/30">Hot Desk</Badge>;
  }
  if (member.member_type === "hub_friend") {
    return <Badge className="text-sm bg-purple-500/20 text-purple-400 border-purple-500/30">Hub Friend</Badge>;
  }
  return <Badge className="text-sm bg-blue-500/20 text-blue-400 border-blue-500/30">Day Pass</Badge>;
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

function AuthUserRow({ u, showMoreCols }: { u: AdminUser; showMoreCols: boolean }) {
  const displayName = u.member?.name ?? u.application?.name ?? null;
  const nameNode = (
    <>
      {displayName ?? <span className="text-muted italic">—</span>}
      {u.member?.is_admin && <span className="ml-2 text-xs text-gold">[Admin]</span>}
      {u.member?.is_coop_member && <span className="ml-1 text-xs text-sage">[Co-op]</span>}
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
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            {memberStatusBadge(u.member)}
            {subBadge(u.subscription)}
            {approvalBadge(u.member?.approved_for_daily, !!u.subscription)}
          </div>
        </td>
        {showMoreCols && <td className="px-4 py-3 text-muted text-sm">{u.member?.telegram_username ?? "—"}</td>}
        <td className="px-4 py-3 text-muted font-mono text-sm">{u.member?.pin_code_slot ?? "—"}</td>
        <td className="px-4 py-3 text-muted text-sm">{u.member ? u.member.day_passes_balance : "—"}</td>
        {showMoreCols && (
          <td className="px-4 py-3 text-muted text-xs">
            {u.lastSignIn ? new Date(u.lastSignIn).toLocaleDateString() : "Never"}
          </td>
        )}
        <td className="px-4 py-3">{action}</td>
      </tr>
      {/* Mobile card */}
      <MemberCard
        name={nameNode}
        email={u.email}
        badge={<div className="flex items-center gap-1.5 flex-wrap">{memberStatusBadge(u.member)}{subBadge(u.subscription)}</div>}
        telegram={u.member?.telegram_username ?? "—"}
        slot={u.member?.pin_code_slot?.toString() ?? "—"}
        passes={u.member ? String(u.member.day_passes_balance) : "—"}
        lastSignIn={u.lastSignIn ? new Date(u.lastSignIn).toLocaleDateString() : "Never"}
        action={action}
      />
    </>
  );
}

function LegacyMemberRow({ m, showMoreCols }: { m: LegacyMemberWithSub; showMoreCols: boolean }) {
  const nameNode = (
    <>
      {m.name}
      {m.is_admin && <span className="ml-2 text-xs text-gold">[Admin]</span>}
      {m.is_coop_member && <span className="ml-1 text-xs text-sage">[Co-op]</span>}
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
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            {memberStatusBadge(m)}
            {subBadge(m.subscription)}
            {approvalBadge(m.approved_for_daily, !!m.subscription)}
          </div>
        </td>
        {showMoreCols && <td className="px-4 py-3 text-muted text-sm">{m.telegram_username ?? "—"}</td>}
        <td className="px-4 py-3 text-muted font-mono text-sm">{m.pin_code_slot ?? "—"}</td>
        <td className="px-4 py-3 text-muted text-sm">{m.day_passes_balance}</td>
        {showMoreCols && <td className="px-4 py-3 text-muted text-xs">—</td>}
        <td className="px-4 py-3">{action}</td>
      </tr>
      <MemberCard
        name={nameNode}
        email={m.email ?? "—"}
        badge={<div className="flex items-center gap-1.5 flex-wrap">{memberStatusBadge(m)}{subBadge(m.subscription)}</div>}
        telegram={m.telegram_username ?? "—"}
        slot={m.pin_code_slot?.toString() ?? "—"}
        passes={String(m.day_passes_balance)}
        lastSignIn="—"
        action={action}
      />
    </>
  );
}

function SkeletonTable() {
  return (
    <div className="glass-panel overflow-hidden">
      <div className="space-y-px">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="grid grid-cols-12 gap-3 px-4 py-3.5 border-b border-white/5 last:border-0">
            <div className="col-span-3 h-3.5 rounded bg-white/5 animate-pulse" />
            <div className="col-span-3 h-3.5 rounded bg-white/5 animate-pulse" />
            <div className="col-span-2 h-3.5 rounded bg-white/5 animate-pulse" />
            <div className="col-span-1 h-3.5 rounded bg-white/5 animate-pulse" />
            <div className="col-span-1 h-3.5 rounded bg-white/5 animate-pulse" />
            <div className="col-span-2 h-3.5 rounded bg-white/5 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function UsersPage() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  // Default to "active" so the directory isn't cluttered with disabled accounts;
  // toggle to "disabled" or "all" via the filter dropdown when needed.
  // Honor ?status=… from the URL so deep links (e.g. "Needs attention"
  // pointing here for the migration backlog) land on the right view.
  const [statusFilter, setStatusFilter] = useState<string>(
    searchParams.get("status") ?? "active",
  );
  const [page, setPage] = useState(0);
  const [showMoreCols, setShowMoreCols] = useState(false);
  const PAGE_SIZE = 25;

  useEffect(() => {
    fetch("/api/admin/users")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError("Failed to load users"));
  }, []);

  // Filter handlers also reset to page 0 — keeps the user from landing on
  // an empty page when the filter shrinks the result set. Done inline
  // rather than via useEffect to avoid the cascading-render lint rule.
  const handleSearchChange = (v: string) => { setSearch(v); setPage(0); };
  const handleTypeChange = (v: string) => { setTypeFilter(v); setPage(0); };
  const handleStatusChange = (v: string) => { setStatusFilter(v); setPage(0); };

  const noProfileCount = data?.users.filter((u) => !u.member).length ?? 0;

  // Client-side search + filter
  const filteredUsers = useMemo(() => {
    if (!data) return [];
    let result = data.users;

    // Type filter
    if (typeFilter === "no_profile") {
      result = result.filter((u) => !u.member);
    } else if (typeFilter !== "all") {
      result = result.filter((u) => u.member?.member_type === typeFilter);
    }

    // Status filter
    if (statusFilter === "active") {
      result = result.filter((u) => u.member && !u.member.disabled);
    } else if (statusFilter === "disabled") {
      result = result.filter((u) => u.member?.disabled);
    } else if (statusFilter === "no_subscription") {
      // Migration backlog: a member exists, isn't disabled, but has no active
      // Stripe subscription. Useful for working through Xero→Stripe moves.
      result = result.filter((u) => u.member && !u.member.disabled && !u.subscription);
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((u) => {
        const name = (u.member?.name ?? u.application?.name ?? "").toLowerCase();
        const email = u.email.toLowerCase();
        const tg = (u.member?.telegram_username ?? "").toLowerCase();
        return name.includes(q) || email.includes(q) || tg.includes(q);
      });
    }

    return result;
  }, [data, search, typeFilter, statusFilter]);

  const filteredLegacy = useMemo(() => {
    if (!data) return [];
    let result = data.legacyMembers;

    // Type filter
    if (typeFilter === "no_profile") return [];
    if (typeFilter !== "all") {
      result = result.filter((m) => m.member_type === typeFilter);
    }

    // Status filter
    if (statusFilter === "active") {
      result = result.filter((m) => !m.disabled);
    } else if (statusFilter === "disabled") {
      result = result.filter((m) => m.disabled);
    } else if (statusFilter === "no_subscription") {
      result = result.filter((m) => !m.disabled && !m.subscription);
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((m) => {
        const name = m.name.toLowerCase();
        const email = (m.email ?? "").toLowerCase();
        const tg = (m.telegram_username ?? "").toLowerCase();
        return name.includes(q) || email.includes(q) || tg.includes(q);
      });
    }

    return result;
  }, [data, search, typeFilter, statusFilter]);

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

      {/* Search + filters */}
      {data && (
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative max-w-sm flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
            <Input
              placeholder="Search by name, email, or Telegram..."
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="glass-input pl-9 pr-8"
            />
            {search && (
              <button
                onClick={() => handleSearchChange("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <select
            value={typeFilter}
            onChange={(e) => handleTypeChange(e.target.value)}
            className="rounded-md px-3 py-2 text-sm glass-input"
          >
            <option value="all">All types</option>
            <option value="cold_desk">Cold Desk</option>
            <option value="hot_desk">Hot Desk</option>
            <option value="hub_friend">Hub Friend</option>
            <option value="day_pass">Day Pass</option>
            <option value="no_profile">No Profile</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => handleStatusChange(e.target.value)}
            className="rounded-md px-3 py-2 text-sm glass-input"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
            <option value="no_subscription">No subscription (migration backlog)</option>
          </select>
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!data ? (
        <SkeletonTable />
      ) : (() => {
        // Tag rows by kind so we can render either component over a unified paginated list
        type Row =
          | { kind: "user"; key: string; u: AdminUser }
          | { kind: "legacy"; key: string; m: LegacyMemberWithSub };
        const rows: Row[] = [
          ...filteredUsers.map((u) => ({ kind: "user" as const, key: `u-${u.authId}`, u })),
          ...filteredLegacy.map((m) => ({ kind: "legacy" as const, key: `l-${m.id}`, m })),
        ];
        const totalRows = rows.length;
        const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
        const safePage = Math.min(page, totalPages - 1);
        const pageRows = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

        return (
          <>
            {/* Toggle for low-priority columns */}
            <div className="flex items-center justify-between flex-wrap gap-2 -mt-2">
              <p className="text-xs text-muted">
                Showing {totalRows === 0 ? 0 : safePage * PAGE_SIZE + 1}–{Math.min(totalRows, (safePage + 1) * PAGE_SIZE)} of {totalRows}
              </p>
              <button
                type="button"
                onClick={() => setShowMoreCols(!showMoreCols)}
                className="text-xs text-muted hover:text-foreground"
              >
                {showMoreCols ? "Hide" : "Show"} Telegram + last sign-in
              </button>
            </div>

            {/* Desktop table */}
            <div className="glass-panel overflow-x-auto hidden sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-muted whitespace-nowrap">
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Email</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    {showMoreCols && <th className="px-4 py-3 font-medium">Telegram</th>}
                    <th className="px-4 py-3 font-medium">Slot</th>
                    <th className="px-4 py-3 font-medium">Passes</th>
                    {showMoreCols && <th className="px-4 py-3 font-medium">Last sign-in</th>}
                    <th className="px-4 py-3 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) =>
                    r.kind === "user"
                      ? <AuthUserRow key={r.key} u={r.u} showMoreCols={showMoreCols} />
                      : <LegacyMemberRow key={r.key} m={r.m} showMoreCols={showMoreCols} />
                  )}
                </tbody>
              </table>

              {pageRows.length === 0 && (
                <p className="text-center text-muted text-sm py-8">
                  {search ? "No matching users." : "No users yet."}
                </p>
              )}
            </div>

            {/* Mobile card list */}
            <div className="space-y-3 sm:hidden">
              {pageRows.map((r) =>
                r.kind === "user"
                  ? <AuthUserRow key={r.key} u={r.u} showMoreCols={showMoreCols} />
                  : <LegacyMemberRow key={r.key} m={r.m} showMoreCols={showMoreCols} />
              )}
              {pageRows.length === 0 && (
                <div className="glass-panel p-8 text-center text-muted text-sm">
                  {search ? "No matching users." : "No users yet."}
                </div>
              )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={safePage === 0}
                  onClick={() => setPage(safePage - 1)}
                  className="btn-glass text-xs"
                >
                  ← Prev
                </Button>
                <span className="text-xs text-muted px-2">
                  Page {safePage + 1} of {totalPages}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage(safePage + 1)}
                  className="btn-glass text-xs"
                >
                  Next →
                </Button>
              </div>
            )}
          </>
        );
      })()}

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
