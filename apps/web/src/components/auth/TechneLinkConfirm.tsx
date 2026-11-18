"use client";

/**
 * The page the link email opens (/auth/techne/link?code=…). It links nothing by itself (mail scanners open
 * links): the person signs in with Techne as the account that asked, if not already, and presses the button.
 * The server checks the code was asked for by this same Techne account (confirm_techne_link).
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TechneConfig } from "@/lib/techne/config";
import type { Session } from "@/lib/techne/call";
import { confirmLink } from "@/lib/techne/portalClient";
import { LINK_PATH } from "@/lib/techne/linkPath";
import { useTechneSession } from "@/components/techne/useTechneSession";
import { SignInWithTechne, SignOutOfTechne } from "@/components/techne/SignInWithTechne";

export function TechneLinkConfirm({ config, code }: { config: TechneConfig; code: string }) {
  const { phase, session, error: signInError, start, signOut } = useTechneSession(
    config,
    `${LINK_PATH}?code=${encodeURIComponent(code)}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await confirmLink(session as Session, config, code);
      window.location.replace("/portal");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't link just now.");
      setBusy(false);
    }
  }

  if (phase === "restoring") {
    return <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted" aria-label="Loading" />;
  }
  return (
    <div className="space-y-5 text-center" data-testid="techne-link-confirm">
      {phase === "signed-in" && session ? (
        <>
          <p className="text-sm text-muted">
            Link the Techne account you&apos;re signed in with to your RegenHub membership. After this, &ldquo;Sign in
            with Techne&rdquo; opens your portal.
          </p>
          <Button type="button" disabled={busy} onClick={() => void link()} className="btn-primary-glass px-6">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Link and open my portal"}
          </Button>
          <p>
            <SignOutOfTechne onSignOut={() => void signOut()} />
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">Sign in with the Techne account you asked from to finish linking.</p>
          <SignInWithTechne busy={phase === "starting"} onStart={(signUp) => void start(signUp)} />
        </>
      )}
      {(error ?? signInError) && (
        <p className="text-sm text-red-300" role="alert">
          {error ?? signInError}
        </p>
      )}
    </div>
  );
}
