import { portalViewer } from "@/lib/admin";
import Link from "next/link";
import { MobileNav, type NavLink } from "@/components/nav/MobileNav";
import { techneConfig } from "@/lib/techne/config";
import { regenosCollectiveDid } from "@/lib/regenos/config";

export const metadata = { title: "Admin — RegenHub" };

const staffLinks: NavLink[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/pipeline", label: "Pipeline" },
  { href: "/admin/members", label: "Members" },
  { href: "/admin/billing", label: "Billing" },
  { href: "/admin/access", label: "Access" },
  { href: "/admin/communications", label: "Comms" },
  { href: "/admin/newsletter", label: "Newsletter" },
];
const stewardsLink: NavLink = { href: "/admin/stewards", label: "Stewards" };
const portalLink: NavLink = { href: "/portal", label: "Portal", accent: true };

/**
 * The admin area's frame. Who may see what is decided below it: the portal admin pages by `members.is_admin`
 * ((staff)/layout.tsx), /admin/stewards by the Techne role in RegenHub. This only chooses which links to show:
 * a RegenHub admin sees them all, anyone else just Stewards (while the Techne door is on).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, isAdmin } = await portalViewer();
  const stewards = techneConfig() && regenosCollectiveDid() ? [stewardsLink] : [];
  const links = [...(isAdmin ? staffLinks : []), ...stewards, ...(user ? [portalLink] : [])];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 px-6 py-3">
        <nav className="glass-panel-subtle max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <MobileNav links={links} />
            <Link href="/" className="text-forest font-bold text-lg">RegenHub</Link>
            <span className="text-xs bg-gold/20 text-gold px-2 py-0.5 rounded-full font-medium">Admin</span>
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
