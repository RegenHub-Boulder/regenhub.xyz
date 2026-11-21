import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { loginUrlFor } from "@/lib/safeNext";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { MobileNav, type NavLink } from "@/components/nav/MobileNav";
import { isStewardEventsEnabled, techneConfig } from "@/lib/techne/config";
import { STEWARD_PATH } from "@/lib/techne/session";
import { currentTechne } from "@/lib/techne/webSession";
import { stewardCheck } from "@/lib/techne/roster";
import { regenosCollectiveDid } from "@/lib/regenos/config";
import { SignOutButton } from "@/components/auth/SignOutButton";

export const metadata = { title: "Member Portal — RegenHub" };

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const path = (await headers()).get("x-pathname");
  const door = !!techneConfig();
  // The stewards' page moved to /admin/events: it answers to the Techne role, not a membership, so an old link
  // goes there before this frame asks for a member session.
  if (door && /^\/portal\/events\/?(\?|$)/.test(path ?? "")) redirect(STEWARD_PATH);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect(loginUrlFor(path));

  const { data: member } = await supabase
    .from("members")
    .select("is_admin, disabled, member_type")
    .eq("supabase_user_id", user.id)
    .single();

  // Matches the admin layout's gate: disabling a member also removes admin.
  const isAdmin = !!member?.is_admin && !member.disabled;

  const links: NavLink[] = [
    { href: "/portal", label: "Home" },
    // One page, named for what it holds: passes for your guests, or a daily member's own day passes.
    { href: "/portal/passes", label: member?.member_type === "day_pass" ? "Day passes" : "Guest passes" },
    ...((await showEvents(door)) ? [{ href: door ? STEWARD_PATH : "/portal/events", label: "Events" }] : []),
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
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className={l.accent ? "text-gold hover:text-gold/80 transition-colors" : "text-muted hover:text-foreground transition-colors"}
                >
                  {l.label}
                </Link>
              ))}
            </div>
          </div>
          <SignOutButton className="hidden sm:block" />
        </nav>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}

/**
 * Events is for stewards: with the Techne door on, only someone signed in with Techne who holds facilitator or above
 * in RegenHub sees it (the page explains itself to anyone else who follows an old link). The roster is read
 * only when there is a Techne session, cached five minutes, so most members cost nothing here. Door off: the old
 * regenOS lane, flag-gated.
 */
async function showEvents(door: boolean): Promise<boolean> {
  if (!door) return isStewardEventsEnabled();
  const collective = regenosCollectiveDid();
  if (!collective) return false;
  try {
    const techne = await currentTechne();
    if (!techne) return false;
    // A hint, not a gate (the Events page checks fresh): a roster up to five minutes old is fine here.
    return !!(await stewardCheck(collective, techne.did, 300))?.steward;
  } catch {
    return false;
  }
}
