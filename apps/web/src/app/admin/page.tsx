import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Users, Key, Zap, UserPlus, AlertTriangle, ClipboardList, Calendar } from "lucide-react";

export default async function AdminPage() {
  const supabase = await createClient();
  const admin = createServiceClient();

  // eslint-disable-next-line react-hooks/purity -- server component, renders once
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const [
    { count: memberCount },
    { count: activeCodeCount },
    { count: expiringSoonCount },
    { count: disabledCount },
    { count: pendingAppCount },
    // Member type breakdown
    { count: coldDeskCount },
    { count: hotDeskCount },
    { count: hubFriendCount },
    { count: dayPassCount },
    // Free day stats
    { count: pendingClaimCount },
    { count: reservedClaimCount },
    // Recent activity
    { data: recentMembers },
    { data: recentApps },
    { data: recentCodes },
  ] = await Promise.all([
    supabase.from("members").select("*", { count: "exact", head: true }).eq("disabled", false),
    supabase.from("day_codes").select("*", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("day_codes").select("*", { count: "exact", head: true })
      .eq("is_active", true)
      .lt("expires_at", oneHourFromNow)
      .gt("expires_at", new Date().toISOString()),
    supabase.from("members").select("*", { count: "exact", head: true }).eq("disabled", true),
    supabase.from("applications").select("*", { count: "exact", head: true }).eq("status", "pending"),
    // Type breakdown
    supabase.from("members").select("*", { count: "exact", head: true }).eq("disabled", false).eq("member_type", "cold_desk"),
    supabase.from("members").select("*", { count: "exact", head: true }).eq("disabled", false).eq("member_type", "hot_desk"),
    supabase.from("members").select("*", { count: "exact", head: true }).eq("disabled", false).eq("member_type", "hub_friend"),
    supabase.from("members").select("*", { count: "exact", head: true }).eq("disabled", false).eq("member_type", "day_pass"),
    // Free day claims
    admin.from("free_day_claims").select("*", { count: "exact", head: true }).eq("status", "pending"),
    admin.from("free_day_claims").select("*", { count: "exact", head: true }).eq("status", "reserved"),
    // Recent activity
    supabase.from("members").select("id, name, member_type, created_at").eq("disabled", false).order("created_at", { ascending: false }).limit(5),
    supabase.from("applications").select("id, name, email, status, created_at").order("created_at", { ascending: false }).limit(5),
    supabase.from("day_codes").select("id, code, label, pin_slot, is_active, created_at, members(name)").order("created_at", { ascending: false }).limit(5),
  ]);

  const typeBreakdown = [
    { label: "Cold Desk", count: coldDeskCount ?? 0, color: "text-green-400" },
    { label: "Hot Desk", count: hotDeskCount ?? 0, color: "text-emerald-400" },
    { label: "Hub Friend", count: hubFriendCount ?? 0, color: "text-purple-400" },
    { label: "Day Pass", count: dayPassCount ?? 0, color: "text-blue-400" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-forest">Admin Dashboard</h1>
        <p className="text-muted mt-1">RegenHub cooperative management</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        <Link href="/admin/members">
          <Card className="glass-panel hover-lift cursor-pointer">
            <CardContent className="p-5">
              <Users className="w-6 h-6 text-sage mb-2" />
              <p className="text-xs text-muted mb-1">Active Members</p>
              <p className="text-3xl font-bold text-foreground">{memberCount ?? 0}</p>
              <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-2">
                {typeBreakdown.map((t) => (
                  <span key={t.label} className={`text-xs ${t.color}`}>
                    {t.count} {t.label.split(" ")[0]}
                  </span>
                ))}
              </div>
              {(disabledCount ?? 0) > 0 && (
                <p className="text-xs text-muted mt-1">{disabledCount} disabled</p>
              )}
            </CardContent>
          </Card>
        </Link>

        <Link href="/admin/codes">
          <Card className="glass-panel hover-lift cursor-pointer">
            <CardContent className="p-5">
              <Key className="w-6 h-6 text-sage mb-2" />
              <p className="text-xs text-muted mb-1">Live Door Codes</p>
              <p className="text-3xl font-bold text-foreground">{activeCodeCount ?? 0}</p>
              {(expiringSoonCount ?? 0) > 0 && (
                <p className="text-xs text-amber-400 mt-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  {expiringSoonCount} expiring within 1hr
                </p>
              )}
            </CardContent>
          </Card>
        </Link>

        <Link href="/admin/applications">
          <Card className="glass-panel hover-lift cursor-pointer">
            <CardContent className="p-5">
              <ClipboardList className="w-6 h-6 text-sage mb-2" />
              <p className="text-xs text-muted mb-1">Applications</p>
              <p className="text-3xl font-bold text-foreground">{pendingAppCount ?? 0}</p>
              {(pendingAppCount ?? 0) > 0 && (
                <p className="text-xs text-amber-400 mt-1">pending review</p>
              )}
            </CardContent>
          </Card>
        </Link>

        <Link href="/admin/claims">
          <Card className="glass-panel hover-lift cursor-pointer">
            <CardContent className="p-5">
              <Calendar className="w-6 h-6 text-sage mb-2" />
              <p className="text-xs text-muted mb-1">Free Days</p>
              <p className="text-3xl font-bold text-foreground">{(pendingClaimCount ?? 0) + (reservedClaimCount ?? 0)}</p>
              <div className="flex gap-2 mt-1 text-xs">
                {(pendingClaimCount ?? 0) > 0 && (
                  <span className="text-amber-400">{pendingClaimCount} pending</span>
                )}
                {(reservedClaimCount ?? 0) > 0 && (
                  <span className="text-sage">{reservedClaimCount} reserved</span>
                )}
              </div>
            </CardContent>
          </Card>
        </Link>

        <Card className="glass-panel">
          <CardContent className="p-5">
            <p className="text-xs text-muted mb-3">Quick Actions</p>
            <div className="flex flex-col gap-2">
              <Link href="/admin/codes">
                <Button size="sm" className="btn-primary-glass w-full gap-2 text-xs">
                  <Zap className="w-3.5 h-3.5" /> Quick Code
                </Button>
              </Link>
              <Link href="/admin/members/new">
                <Button size="sm" className="btn-glass w-full gap-2 text-xs">
                  <UserPlus className="w-3.5 h-3.5" /> Add Member
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent activity */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Recent members */}
        <Card className="glass-panel">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Users className="w-4 h-4 text-sage" /> Recent Members
              </h3>
              <Link href="/admin/members" className="text-xs text-muted hover:text-foreground">View all</Link>
            </div>
            <div className="space-y-3">
              {(recentMembers ?? []).length === 0 ? (
                <p className="text-xs text-muted">No members yet.</p>
              ) : (
                recentMembers!.map((m) => (
                  <Link key={m.id} href={`/admin/members/${m.id}`} className="flex items-center justify-between gap-2 group">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate group-hover:text-sage transition-colors">{m.name}</p>
                      <p className="text-xs text-muted capitalize">{m.member_type.replace(/_/g, " ")}</p>
                    </div>
                    <span className="text-xs text-muted shrink-0">
                      {new Date(m.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  </Link>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Recent applications */}
        <Card className="glass-panel">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ClipboardList className="w-4 h-4 text-sage" /> Recent Applications
              </h3>
              <Link href="/admin/applications" className="text-xs text-muted hover:text-foreground">View all</Link>
            </div>
            <div className="space-y-3">
              {(recentApps ?? []).length === 0 ? (
                <p className="text-xs text-muted">No applications yet.</p>
              ) : (
                recentApps!.map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{a.name}</p>
                      <p className="text-xs text-muted">{a.email}</p>
                    </div>
                    <span className={`text-xs shrink-0 ${
                      a.status === "pending" ? "text-amber-400" :
                      a.status === "approved" ? "text-emerald-400" : "text-red-400"
                    }`}>
                      {a.status}
                    </span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Recent codes */}
        <Card className="glass-panel">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Key className="w-4 h-4 text-sage" /> Recent Codes
              </h3>
              <Link href="/admin/codes" className="text-xs text-muted hover:text-foreground">View all</Link>
            </div>
            <div className="space-y-3">
              {(recentCodes ?? []).length === 0 ? (
                <p className="text-xs text-muted">No codes yet.</p>
              ) : (
                recentCodes!.map((c: Record<string, unknown>) => (
                  <div key={c.id as number} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-mono text-gold">{c.code as string}</p>
                      <p className="text-xs text-muted">
                        {(c.label as string) ?? (c.members as { name: string } | null)?.name ?? `Slot ${c.pin_slot}`}
                      </p>
                    </div>
                    <span className={`text-xs shrink-0 ${c.is_active ? "text-sage" : "text-muted"}`}>
                      {c.is_active ? "active" : "revoked"}
                    </span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
