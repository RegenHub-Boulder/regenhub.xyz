"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OAuthSignInButton } from "@/components/auth/OAuthSignInButton";

/**
 * The regenOS sign-in lane (Phase 2, behind REGENOS_LOGIN_ENABLED).
 *
 * Rendered ABOVE the existing Supabase form, never instead of it — the classic
 * one-time-link door stays as the fallback lane for the whole transition, so a
 * regenOS outage can never lock members out of their own door.
 *
 * Two regenOS doors into the SAME finish, both through this app's own
 * same-origin /xrpc proxy so the AppView's `__Host-rs_session` cookie lands
 * on regenhub.xyz:
 *
 *   1. Email bridge (below) — beginSignup { email }
 *        → stage "login"        (regenOS trusted the session immediately)  → finish
 *        → stage "checkEmail"   (magic link sent)                          → wait, then finish
 *        → stage "chooseHandle" (no regenOS account for this email)        → point at the classic lane
 *   2. Real atproto OAuth (<OAuthSignInButton>, `lib/regenos/oauth.ts`) — an
 *      atproto handle → beginOAuth → PDS consent → `/oauth/callback` lands
 *      the same session cookie → finish. This is the mechanism Aaron asked
 *      for (regenOS acting like Google OAuth); the email bridge stays as a
 *      second door, not a stepping-stone to be deleted.
 *
 * "Finish" is POST /api/auth/regenos/session: match the verified email to a
 * membership, link the DID, mint the RegenHub session. Both doors call it —
 * <OAuthCallback> (`components/auth/OAuthCallback.tsx`) calls it itself once
 * its own cookie has landed, so this component's `finish()` only ever
 * services the email-bridge doors above.
 */

/** Which view is on screen. `busy` is tracked separately so an in-flight
 *  request never yanks the view out from under the person. */
type Stage = "idle" | "checkEmail" | "noAccount";

interface BeginSignupResponse {
  stage?: string;
  returningUser?: boolean;
}

interface SessionResponse {
  ok?: boolean;
  member?: boolean;
  redirect?: string;
  error?: string;
}

export function RegenosLoginPanel({ next = "/portal" }: { next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A regenOS session already on this browser — e.g. they just clicked the link. */
  const [existingHandle, setExistingHandle] = useState<string | null | undefined>(undefined);

  // On mount, ask regenOS whether this browser is already signed in. If it is,
  // we offer a one-click continue instead of asking for an email they've
  // already proven. Anonymous callers get `{}` — no error, no noise.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/xrpc/social.scenius.getSession", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { did?: string; handle?: string };
        if (!cancelled && data.did) setExistingHandle(data.handle ?? data.did);
      } catch {
        // regenOS unreachable — the classic lane below still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/regenos/session", { method: "POST" });
      const data = (await res.json()) as SessionResponse;
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Couldn't finish signing you in.");
        return;
      }
      router.push(data.member ? next : (data.redirect ?? "/membership"));
      router.refresh();
    } catch {
      setError("Couldn't reach RegenHub. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    let data: BeginSignupResponse;
    try {
      const res = await fetch("/xrpc/social.scenius.beginSignup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        setError("regenOS didn't accept that email. Try the classic sign-in link below.");
        return;
      }
      data = (await res.json()) as BeginSignupResponse;
    } catch {
      setError("Can't reach regenOS right now. Use the classic sign-in link below.");
      return;
    } finally {
      setBusy(false);
    }

    if (data.stage === "login") {
      // regenOS trusted the session immediately — no inbox round-trip.
      await finish();
    } else if (data.stage === "checkEmail") {
      setStage("checkEmail");
    } else {
      // "chooseHandle" — regenOS has no account for this email yet AND trusted
      // the address without an inbox round-trip. That's BETA mode; PROD runs
      // email mode, where a new address comes back "checkEmail" above and the
      // emailed link lands on `/login?token=…` (`app/login/page.tsx`), which
      // finishes the signup wizard in-app. So this branch is the beta-only
      // tail: creating an account inline is a wizard, not a login surface, and
      // the classic lane is the answer.
      setStage("noAccount");
    }
  }

  if (existingHandle) {
    return (
      <Panel>
        <p className="text-sm text-muted">
          You&apos;re signed in to regenOS as <strong>{existingHandle}</strong>.
        </p>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <Button onClick={finish} disabled={busy} className="btn-primary-glass w-full">
          {busy ? "Signing you in…" : "Continue to RegenHub"}
        </Button>
      </Panel>
    );
  }

  if (stage === "checkEmail") {
    return (
      <Panel>
        <div className="text-center space-y-1">
          <div className="text-3xl">📬</div>
          <p className="text-sm text-muted">
            regenOS sent a sign-in link to <strong>{email}</strong>. Open it, then come back here.
          </p>
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <Button onClick={finish} disabled={busy} className="btn-glass w-full">
          {busy ? "Signing you in…" : "I've clicked the link"}
        </Button>
      </Panel>
    );
  }

  if (stage === "noAccount") {
    return (
      <Panel>
        <p className="text-sm text-muted">
          No regenOS account for <strong>{email}</strong> yet. Use the classic sign-in link below —
          it works exactly as it always has.
        </p>
        <Button onClick={() => setStage("idle")} className="btn-glass w-full">
          Try a different email
        </Button>
      </Panel>
    );
  }

  return (
    <Panel>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="regenos-email">Sign in with your membership email</Label>
          <Input
            id="regenos-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            className="bg-white/10 border-white/20 text-foreground placeholder:text-muted"
          />
          <p className="text-xs text-muted">
            Use your membership email — that&apos;s how we find your RegenHub account.
          </p>
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <Button type="submit" disabled={busy} className="btn-primary-glass w-full">
          {busy ? "Checking…" : "Continue with regenOS"}
        </Button>
      </form>
      <OAuthSignInButton />
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4">{children}</div>;
}
