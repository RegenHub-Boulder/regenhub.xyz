"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import type { TechneConfig } from "@/lib/techne/config";
import { authOptions, safeReturn } from "@/lib/techne/session";
import { openPortal } from "@/lib/techne/portalClient";
import type { Session } from "@/lib/techne/call";

/**
 * Finishes "Sign in with Techne" (techne-sdk `restore`), opens the portal session when this Techne account is a
 * member's (the one door, lib/techne/portalClient.ts), and goes back to the page it started on. A visitor who
 * isn't a member just goes back: RSVP works, and a portal page sends them to /auth/login, which offers the link.
 */
export function TechneCallback({ config }: { config: TechneConfig }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const auth = await import("techne-sdk/auth");
        const opts = await authOptions(config);
        const session = await auth.restore(opts);
        const state = session ? await auth.redirectState(opts) : null;
        // The portal half is a bonus here: if it fails, RSVP still works and /auth/login retries it.
        if (session) await openPortal(session as Session, config).catch(() => null);
        window.location.replace(safeReturn(state));
      } catch {
        setFailed(true);
      }
    })();
  }, [config]);

  return (
    <div className="px-6 py-24 text-center space-y-3">
      {failed ? (
        <>
          <p className="text-lg">Sign-in didn&apos;t finish.</p>
          <Link href="/events" className="text-sage hover:underline">
            Back to events
          </Link>
        </>
      ) : (
        <p className="inline-flex items-center gap-2 text-muted">
          <Loader2 className="w-5 h-5 animate-spin" /> Signing you in…
        </p>
      )}
    </div>
  );
}
