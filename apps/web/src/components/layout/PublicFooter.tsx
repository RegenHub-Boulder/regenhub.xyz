import Image from "next/image";
import Link from "next/link";
import { MapPin } from "lucide-react";
import { PUBLIC_NAV, HUB_ADDRESS, HUB_EMAIL, HUB_TELEGRAM } from "@/components/layout/publicNav";
import regenHubLogo from "@/assets/regenhub-logo.svg";
import regenHubText from "@/assets/regenhub-text.svg";

/**
 * The one public footer: where we are, how to reach us, where else to go.
 * The street address leads because "a coworking space in Boulder" was the most
 * a visitor could learn from the whole site.
 */
export function PublicFooter() {
  return (
    <footer className="relative px-6 py-12 mt-16">
      <div className="max-w-4xl mx-auto">
        <div className="glass-panel p-8 text-center">
          <div className="flex items-center justify-center gap-2 mb-4">
            <Image src={regenHubLogo} alt="" width={32} height={32} className="animate-sway" />
            <Image src={regenHubText} alt="RegenHub" height={32} className="h-8 w-auto" />
          </div>

          <p className="flex items-center justify-center gap-2 text-base font-medium">
            <MapPin className="w-4 h-4 text-sage shrink-0" />
            {HUB_ADDRESS}
          </p>
          <p className="mt-2 text-sm text-muted">
            <a href={`mailto:${HUB_EMAIL}`} className="hover:text-sage transition-colors">{HUB_EMAIL}</a>
            <span className="mx-2 text-muted/50">·</span>
            <a
              href={HUB_TELEGRAM}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-sage transition-colors"
            >
              Telegram community chat
            </a>
          </p>

          <nav className="flex justify-center gap-x-5 gap-y-2 flex-wrap mt-6 text-sm">
            {PUBLIC_NAV.map(({ href, label }) => (
              <Link key={href} href={href} className="text-muted hover:text-foreground transition-colors">
                {label}
              </Link>
            ))}
            <Link href="/apply" className="text-muted hover:text-foreground transition-colors">Apply</Link>
            <Link href="/interest" className="text-muted hover:text-foreground transition-colors">Stay in Touch</Link>
            <Link href="/portal" className="text-muted hover:text-foreground transition-colors">Member Portal</Link>
          </nav>

          <div className="text-xs text-muted/80 space-y-1 mt-6">
            <p>&copy; 2026 RegenHub Limited Cooperative Association</p>
            <p>A Colorado public benefit limited cooperative association</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
