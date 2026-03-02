import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

export const metadata = { title: "Admin — RegenHub" };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/auth/login");

  const { data: member } = await supabase
    .from("members")
    .select("is_admin")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member?.is_admin) redirect("/portal");

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 px-6 py-3">
        <nav className="glass-panel-subtle max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-forest font-bold text-lg">RegenHub</Link>
            <span className="text-xs bg-gold/20 text-gold px-2 py-0.5 rounded-full font-medium">Admin</span>
            <div className="hidden sm:flex gap-4 text-sm">
              <Link href="/admin" className="text-muted hover:text-foreground transition-colors">Overview</Link>
              <Link href="/admin/members" className="text-muted hover:text-foreground transition-colors">Members</Link>
              <Link href="/admin/codes" className="text-muted hover:text-foreground transition-colors">Live Codes</Link>
              <Link href="/admin/lock" className="text-muted hover:text-foreground transition-colors">Lock Sync</Link>
            </div>
          </div>
          <Link href="/portal" className="text-sm text-muted hover:text-foreground transition-colors">
            Portal →
          </Link>
        </nav>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}
