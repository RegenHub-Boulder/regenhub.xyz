import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MobileNav } from "@/components/nav/MobileNav";
import { PUBLIC_NAV } from "@/components/layout/publicNav";
import regenHubLogo from "@/assets/regenhub-logo.svg";
import regenHubText from "@/assets/regenhub-text.svg";

/**
 * The one public header. Every page a stranger can reach renders this — there
 * used to be six different treatments and most pages had none at all.
 *
 * Mobile: the nav collapses into the existing drawer and the wordmark shrinks,
 * so the Member Portal button can no longer clip it at 390px.
 */
export function PublicHeader() {
  return (
    <header className="relative z-50 px-3 sm:px-6 py-4">
      <nav className="glass-panel-subtle max-w-7xl mx-auto px-3 sm:px-6 py-3 flex items-center justify-between gap-2 sm:gap-3">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <MobileNav links={PUBLIC_NAV} />
          <Link href="/" className="flex items-center gap-2 min-w-0" aria-label="RegenHub home">
            <Image
              src={regenHubLogo}
              alt=""
              width={32}
              height={32}
              className="h-6 w-6 sm:h-8 sm:w-8 shrink-0 animate-sway"
            />
            <Image
              src={regenHubText}
              alt="RegenHub"
              height={32}
              className="h-4 sm:h-7 w-auto shrink-0"
            />
          </Link>
        </div>

        <div className="hidden sm:flex items-center gap-5 text-sm">
          {PUBLIC_NAV.map(({ href, label }) => (
            <Link key={href} href={href} className="text-muted hover:text-foreground transition-colors">
              {label}
            </Link>
          ))}
        </div>

        <Link href="/portal" className="shrink-0">
          {/* "Member Portal" is wide enough at 390px to push the wordmark off
              the left edge, which is exactly what the old header did. */}
          <Button size="sm" className="btn-glass whitespace-nowrap">
            <span className="sm:hidden">Portal</span>
            <span className="hidden sm:inline">Member Portal</span>
          </Button>
        </Link>
      </nav>
    </header>
  );
}
