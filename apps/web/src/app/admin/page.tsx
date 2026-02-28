import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { Users, Key, Shield, Activity } from "lucide-react";

export default async function AdminPage() {
  const supabase = await createClient();

  const [
    { count: memberCount },
    { count: activeCodeCount },
    { count: dayPassCount },
  ] = await Promise.all([
    supabase.from("members").select("*", { count: "exact", head: true }).eq("disabled", false),
    supabase.from("day_codes").select("*", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("day_passes").select("*", { count: "exact", head: true }),
  ]);

  const stats = [
    { label: "Active Members", value: memberCount ?? 0, icon: Users, href: "/admin/members" },
    { label: "Live Door Codes", value: activeCodeCount ?? 0, icon: Key, href: "/admin/codes" },
    { label: "Day Pass Pools", value: dayPassCount ?? 0, icon: Shield, href: "/admin/members" },
    { label: "Lock Sync", value: "Manage", icon: Activity, href: "/admin/lock" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-forest">Admin Dashboard</h1>
        <p className="text-muted mt-1">RegenHub cooperative management</p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map(({ label, value, icon: Icon, href }) => (
          <Link key={label} href={href}>
            <Card className="glass-panel hover-lift cursor-pointer">
              <CardContent className="p-6">
                <Icon className="w-6 h-6 text-sage mb-3" />
                <p className="text-sm text-muted mb-1">{label}</p>
                <p className="text-3xl font-bold text-foreground">{value}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
