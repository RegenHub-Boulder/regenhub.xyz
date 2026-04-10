import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Users, Key, Activity, Zap, UserPlus, AlertTriangle, ClipboardList } from "lucide-react";

export default async function AdminPage() {
  const supabase = await createClient();

  // eslint-disable-next-line react-hooks/purity -- server component, renders once
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const [
    { count: memberCount },
    { count: activeCodeCount },
    { count: expiringSoonCount },
    { count: disabledCount },
    { count: pendingAppCount },
  ] = await Promise.all([
    supabase.from("members").select("*", { count: "exact", head: true }).eq("disabled", false),
    supabase.from("day_codes").select("*", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("day_codes").select("*", { count: "exact", head: true })
      .eq("is_active", true)
      .lt("expires_at", oneHourFromNow)
      .gt("expires_at", new Date().toISOString()),
    supabase.from("members").select("*", { count: "exact", head: true }).eq("disabled", true),
    supabase.from("applications").select("*", { count: "exact", head: true }).eq("status", "pending"),
  ]);

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

        <Link href="/admin/lock">
          <Card className="glass-panel hover-lift cursor-pointer">
            <CardContent className="p-5">
              <Activity className="w-6 h-6 text-sage mb-2" />
              <p className="text-xs text-muted mb-1">Lock Sync</p>
              <p className="text-xl font-bold text-foreground mt-1">Manage</p>
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
    </div>
  );
}
