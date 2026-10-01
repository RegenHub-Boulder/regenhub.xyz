"use client";

import { useState, useEffect, useRef, useId } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

// Public and portal layouts normally mount one menu. Coordinate any overlap
// synchronously so stale effect cleanup cannot release the new owner’s locks.
let dismissActiveMenu: (() => void) | undefined;

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
  const dialogId = useId();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- portal needs the client document
  useEffect(() => { setMounted(true); }, []);
  const openButtonRef = useRef<HTMLButtonElement>(null);

  // Close drawer on route change — links already call setOpen(false) on click,
  // but this catches programmatic navigation and browser back/forward.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: sync UI state with external navigation
  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open || !mounted) return;
    const desktop = window.matchMedia("(min-width: 640px)");
    const onResize = () => { if (desktop.matches) setOpen(false); };
    if (desktop.matches) { onResize(); return; }
    dismissActiveMenu?.();
    desktop.addEventListener("change", onResize);
    const trigger = openButtonRef.current;
    const drawer = drawerRef.current!;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // The portal is a direct body child, so making its siblings inert covers
    // the entire background without making the dialog itself inert.
    const background = [...document.body.children].filter(el => el !== modalRef.current);
    const previous = background.map(el => el.hasAttribute("inert"));
    background.forEach(el => el.setAttribute("inert", ""));
    const focusable = () => [...drawer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
    )].filter(el => !el.closest('[inert], [hidden]'));
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0] ?? drawer;
      const last = elements.at(-1) ?? drawer;
      if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (!drawer.contains(event.target as Node)) closeButtonRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocus);
    let released = false;
    const release = (restoreFocus: boolean) => {
      if (released) return;
      released = true;
      if (dismissActiveMenu === dismiss) dismissActiveMenu = undefined;
      desktop.removeEventListener("change", onResize);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocus);
      background.forEach((el, i) => { if (!previous[i]) el.removeAttribute("inert"); });
      document.body.style.overflow = overflow;
      if (restoreFocus && !desktop.matches && trigger?.isConnected && !trigger.closest("[inert]")) trigger.focus();
    };
    const dismiss = () => { release(false); setOpen(false); };
    dismissActiveMenu = dismiss;
    return () => release(true);
  }, [open, mounted]);

  return (
    <>
      {/* Hamburger button — visible only on mobile */}
      <button
        ref={openButtonRef}
        onClick={() => setOpen(true)}
        className="sm:hidden p-2 -ml-2 text-muted hover:text-foreground transition-colors"
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls={dialogId}
      >
        <Menu size={22} />
      </button>

      {mounted && createPortal(<div ref={modalRef}>
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
        ref={drawerRef}
        id={dialogId}
        role="dialog"
        aria-modal={open ? true : undefined}
        aria-label="Navigation menu"
        tabIndex={-1}
        inert={!open}
        aria-hidden={!open}
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
            ref={closeButtonRef}
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
      </div>, document.body)}
    </>
  );
}
