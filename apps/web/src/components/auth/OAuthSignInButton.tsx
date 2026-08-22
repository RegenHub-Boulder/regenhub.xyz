"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RegenosOAuthError, requestAuthorizeUrl } from "@/lib/regenos/oauth";

/**
 * <OAuthSignInButton> — the real atproto OAuth sign-in affordance (the thing
 * this build is FOR: regenOS acting like Google OAuth, not the email-match
 * bridge). Coexists with the magic-link form above it in
 * `RegenosLoginPanel.tsx` — both end up at the same
 * `POST /api/auth/regenos/session` handoff once a regenOS session cookie
 * exists on this origin, just via a different door.
 *
 * It's a minimal form, not a bare button: the AppView's real atrium OAuth
 * client resolves the person's authorization server from an IDENTIFIER
 * (handle / DID / PDS URL) before PAR, so one has to be collected up front —
 * mirrors regenOS's own `<OAuthSignInButton>`
 * (`apps/scenius-web/src/components/oauth-sign-in-button.tsx`).
 *
 * `requestAuthorizeUrl` POSTs `social.scenius.beginOAuth` (forwarding
 * `{identifier, clientId, redirectUri}`) through this app's same-origin
 * `/xrpc` proxy; on success this navigates the browser to the PDS consent
 * screen it returns. A begin FAILURE (unresolvable handle, AppView error)
 * surfaces inline instead.
 */
export function OAuthSignInButton() {
  const [identifier, setIdentifier] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = identifier.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      const authorizeUrl = await requestAuthorizeUrl(trimmed);
      window.location.assign(authorizeUrl);
      // Navigation takes over; leave `busy` true so nothing re-enables the
      // form during the redirect.
    } catch (err) {
      setError(
        err instanceof RegenosOAuthError && err.message
          ? err.message
          : "Could not start sign-in. Check the handle and try again.",
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <div className="space-y-2">
        <Label htmlFor="regenos-oauth-identifier">Or sign in with your atproto handle</Label>
        <Input
          id="regenos-oauth-identifier"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="you.bsky.social"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy}
          className="bg-white/10 border-white/20 text-foreground placeholder:text-muted"
        />
      </div>
      {error && (
        <p className="text-red-400 text-sm" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!canSubmit} className="btn-glass w-full">
        {busy ? "Taking you there…" : "Sign in with atproto"}
      </Button>
    </form>
  );
}
