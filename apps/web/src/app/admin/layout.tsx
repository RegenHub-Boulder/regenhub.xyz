import { portalViewer } from "@/lib/admin";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { MobileNav, type NavLink } from "@/components/nav/MobileNav";
import { techneConfig } from "@/lib/techne/config";
import { regenosCollectiveDid } from "@/lib/regenos/config";
import { currentViewAs, previewFrame } from "@/lib/viewAsServer";
import { ViewAsBar } from "@/components/portal/ViewAsBar";

export const metadata = { title: "Admin — RegenHub" };

// Seven, in the order an admin's week runs. Events sits sixth and only shows while the Techne door is on (its page
// answers to the Techne role, not this site's admin flag); a steward who isn't a site admin sees just Events.
const before: NavLink[] = [
  { href: "/admin", label: "Today" },
  { href: "/admin/scoreboard", label: "Scoreboard" },
  { href: "/admin/people", label: "People" },
  { href: "/admin/billing", label: "Billing" },
  { href: "/admin/access", label: "Door" },
];
const eventsLink: NavLink = { href: "/admin/events", label: "Events" };
const after: NavLink[] = [{ href: "/admin/mail", label: "Mail" }];
const portalLink: NavLink = { href: "/portal", label: "Portal", accent: true };

/**
 * The admin area's frame. Who may see what is decided below it: the portal admin pages by `members.is_admin`
 * ((staff)/layout.tsx), /admin/events (with its Roles section) by the Techne role in RegenHub. This only chooses
 * which links to show: a RegenHub admin sees them all, anyone else just Events (while the Techne door is on).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, isAdmin } = await portalViewer();
  const events = techneConfig() && regenosCollectiveDid() ? [eventsLink] : [];
  const links = [...(isAdmin ? [...before, ...events, ...after] : events), ...(user ? [portalLink] : [])];
  // While a portal preview is on (lib/viewAs.ts) every write is paused here too: say so.
  const viewAs = isAdmin ? await currentViewAs() : null;
  const preview = viewAs ? await previewFrame(viewAs) : null;

  return (
    <div className="min-h-screen" data-surface="work">
      {preview && <ViewAsBar label={preview.label} />}
      <header className="sticky top-0 z-50 px-6 py-3">
        <nav className="glass-panel-subtle max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <MobileNav links={links} />
            <Link href="/" className="text-forest font-bold text-lg">RegenHub</Link>
            <Badge>Admin</Badge>
            <div className="hidden sm:flex gap-4 text-sm">
              {links
                .filter((l) => !l.accent) // accent links (Portal) render separately below
                .map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className="text-muted hover:text-foreground transition-colors"
                  >
                    {l.label}
                  </Link>
                ))}
            </div>
          </div>
          {user && (
            <Link href="/portal" className="text-sm text-muted hover:text-foreground transition-colors">
              Portal →
            </Link>
          )}
        </nav>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}
