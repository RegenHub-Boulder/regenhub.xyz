"use client";

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "regenhub-pwa-install-dismissed-at";
// Don't pester for 30 days after a dismiss.
const SUPPRESS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Subtle bottom-right card prompting installation. Renders only when:
 *  - browser supports beforeinstallprompt (Android Chrome, Edge)
 *  - app isn't already installed (display-mode != standalone)
 *  - user hasn't dismissed it in the last 30 days
 *
 * iOS Safari doesn't fire beforeinstallprompt, so we skip the nudge there —
 * Apple makes "Add to Home Screen" a manual step regardless.
 */
export function InstallPrompt() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Already installed?
    if (window.matchMedia("(display-mode: standalone)").matches) return;

    // Recently dismissed?
    const last = Number(localStorage.getItem(DISMISSED_KEY) ?? "0");
    if (last && Date.now() - last < SUPPRESS_MS) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
      setHidden(false);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  if (hidden || !evt) return null;

  async function accept() {
    if (!evt) return;
    await evt.prompt();
    await evt.userChoice;
    setHidden(true);
    setEvt(null);
  }

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    setHidden(true);
  }

  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto sm:max-w-sm z-50 glass-panel-strong border border-sage/30 p-4 shadow-lg">
      <div className="flex items-start gap-3">
        <Download className="w-5 h-5 text-sage shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-sm font-medium">Install RegenHub on your phone</p>
          <p className="text-xs text-muted mt-1">
            Your door code works offline so you can unlock the door even with bad cell signal.
          </p>
          <div className="flex gap-2 mt-3">
            <Button size="sm" onClick={accept} className="btn-primary-glass text-xs h-7 gap-1">
              <Download className="w-3 h-3" /> Install
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss} className="text-muted text-xs h-7">
              Not now
            </Button>
          </div>
        </div>
        <button onClick={dismiss} className="text-muted hover:text-foreground" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
