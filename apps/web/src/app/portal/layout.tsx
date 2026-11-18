import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { loginUrlFor } from "@/lib/safeNext";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { MobileNav, type NavLink } from "@/components/nav/MobileNav";
import { isStewardEventsEnabled } from "@/lib/techne/config";
import { SignOutButton } from "@/components/auth/SignOutButton";

export const metadata = { title: "Member Portal — RegenHub" };

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect(loginUrlFor((await headers()).get("x-pathname")));

  const { data: member } = await supabase
    .from("members")
    .select("is_admin, disabled")
    .eq("supabase_user_id", user.id)
    .single();

  // Matches the admin layout's gate: disabling a member also removes admin.
  const isAdmin = !!member?.is_admin && !member.disabled;

  // Flag-gated only: the page itself says what you may do. The Techne door, or the old regenOS lane.
  const eventsEnabled = isStewardEventsEnabled();

  const links: NavLink[] = [
    { href: "/portal", label: "Dashboard" },
    { href: "/portal/my-code", label: "My Code" },
    { href: "/portal/passes", label: "Live Codes" },
    { href: "/portal/profile", label: "Profile" },
    ...(eventsEnabled ? [{ href: "/portal/events", label: "Events" }] : []),
    ...(isAdmin ? [{ href: "/admin", label: "Admin", accent: true }] : []),
  ];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 px-6 py-3">
        <nav className="glass-panel-subtle max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <MobileNav
              links={links}
              trailing={<SignOutButton />}
            />
            <Link href="/" className="text-forest font-bold text-lg">RegenHub</Link>
            <div className="hidden sm:flex gap-4 text-sm">
              <Link href="/portal" className="text-muted hover:text-foreground transition-colors">Dashboard</Link>
              <Link href="/portal/my-code" className="text-muted hover:text-foreground transition-colors">My Code</Link>
              <Link href="/portal/passes" className="text-muted hover:text-foreground transition-colors">Live Codes</Link>
              <Link href="/portal/profile" className="text-muted hover:text-foreground transition-colors">Profile</Link>
              {eventsEnabled && (
                <Link href="/portal/events" className="text-muted hover:text-foreground transition-colors">Events</Link>
              )}
              {isAdmin && (
                <Link href="/admin" className="text-gold hover:text-gold/80 transition-colors">Admin</Link>
              )}
            </div>
          </div>
          <SignOutButton className="hidden sm:block" />
        </nav>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}
