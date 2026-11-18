"use client";

/**
 * The "Sign in with Techne" button and its "Make one" link: the site's one sign-in button (/auth/login,
 * /apply, RSVP, the link page, the stewards' page).
 * The label and busy behaviour follow the docs' <SignInWithTechne />, which techne-sdk 0.4.0 doesn't
 * ship yet (docs/TECHNE-SIGN-IN.md).
 */

import { LogOut, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SignInWithTechne({
  busy,
  onStart,
}: {
  busy: boolean;
  onStart: (signUp: boolean) => void;
}) {
  return (
    <div className="space-y-3 max-w-sm mx-auto">
      <Button
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={() => onStart(false)}
        className="btn-primary-glass px-6"
      >
        Sign in with Techne
      </Button>
      <p className="text-xs text-muted leading-relaxed">
        One Techne account works on every Techne app.{" "}
        <button type="button" onClick={() => onStart(true)} className="text-sage hover:underline inline-flex items-center gap-1">
          <UserPlus className="w-3 h-3" /> Make one
        </button>
      </p>
    </div>
  );
}

/** Ends both sessions (Techne and the portal): useTechneSession's signOut. */
export function SignOutOfTechne({ onSignOut }: { onSignOut: () => void }) {
  return (
    <button type="button" onClick={onSignOut} className="text-xs text-muted hover:text-foreground inline-flex items-center gap-1">
      <LogOut className="w-3 h-3" /> Sign out
    </button>
  );
}
