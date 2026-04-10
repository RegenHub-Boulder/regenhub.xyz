"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

export interface NavLink {
  href: string;
  label: string;
  accent?: boolean; // e.g. "Admin" link in gold
}

interface MobileNavProps {
  links: NavLink[];
  /** Content shown in the right side of the mobile header (sign out form, portal link, etc.) */
  trailing?: React.ReactNode;
}

export function MobileNav({ links, trailing }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close drawer on route change — links already call setOpen(false) on click,
  // but this catches programmatic navigation and browser back/forward.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: sync UI state with external navigation
  useEffect(() => { setOpen(false); }, [pathname]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [open]);

  return (
    <>
      {/* Hamburger button — visible only on mobile */}
      <button
        onClick={() => setOpen(true)}
        className="sm:hidden p-2 -ml-2 text-muted hover:text-foreground transition-colors"
        aria-label="Open menu"
      >
        <Menu size={22} />
      </button>

      {/* Overlay */}
      {open && (
        <div
          className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm sm:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      {/* Drawer */}
      <div
        className={`fixed top-0 left-0 z-[101] h-full w-72 sm:hidden
          glass-panel-strong border-r border-white/10
          transform transition-transform duration-250 ease-out
          ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <Link
            href="/"
            className="text-forest font-bold text-lg"
            onClick={() => setOpen(false)}
          >
            RegenHub
          </Link>
          <button
            onClick={() => setOpen(false)}
            className="p-1 text-muted hover:text-foreground transition-colors"
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>

        {/* Nav links */}
        <nav className="flex flex-col py-3">
          {links.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className={`px-5 py-3 text-sm transition-colors ${
                  isActive
                    ? link.accent
                      ? "text-gold bg-gold/10 border-l-2 border-gold"
                      : "text-foreground bg-white/5 border-l-2 border-forest"
                    : link.accent
                      ? "text-gold hover:bg-gold/5"
                      : "text-muted hover:text-foreground hover:bg-white/5"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        {/* Bottom area — trailing content (sign out, etc.) */}
        {trailing && (
          <div className="absolute bottom-0 left-0 right-0 px-5 py-4 border-t border-white/10">
            {trailing}
          </div>
        )}
      </div>
    </>
  );
}
