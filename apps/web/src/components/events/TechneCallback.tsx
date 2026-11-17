"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import type { RsvpConfig } from "@/lib/techne/rsvp";
import { authOptions, safeReturn } from "@/lib/techne/session";

/** Finishes "Sign in with Techne" (techne-sdk `restore`) and goes back to the page it started on. */
export function TechneCallback({ config }: { config: RsvpConfig }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const auth = await import("techne-sdk/auth");
        const opts = await authOptions(config);
        const session = await auth.restore(opts);
        const state = session ? await auth.redirectState(opts) : null;
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
