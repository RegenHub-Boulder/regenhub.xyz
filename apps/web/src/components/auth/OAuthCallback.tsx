"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { resolveOAuthCallback, type OAuthCallbackResult } from "@/lib/regenos/oauth";

/**
 * <OAuthCallback> — the browser side of `/oauth/callback`.
 *
 * The PDS lands the browser here (a top-level same-origin navigation, so the
 * sealed AppView state cookie rides along). This hands `code`/`state`/`iss`
 * to `resolveOAuthCallback`, which forwards them to the AppView's
 * `social.scenius.oauthCallback` through this app's same-origin `/xrpc`
 * proxy with `credentials:'include'` — the AppView verifies + mints, the
 * proxy relays `Set-Cookie __Host-rs_session` onto regenhub.xyz.
 *
 * On success it does NOT stop there: unlike regenOS's own apps (where
 * landing the cookie IS being signed in), regenhub.xyz still needs to run
 * the SAME downstream handoff the magic-link lane uses — match the verified
 * email to a `members` row, mint the Supabase session
 * (`POST /api/auth/regenos/session`, `RegenosLoginPanel.tsx`'s `finish()`).
 * This stays mounted only on failure, rendering the mapped error states;
 * on success the navigation to `/portal` or `/membership` takes over.
 *
 * MUST run in the browser (the session cookie only "lands" via the
 * browser's own fetch + cookie jar), hence a client component.
 */
type Failure = Extract<OAuthCallbackResult, { ok: false }>;

interface SessionResponse {
  ok?: boolean;
  member?: boolean;
  redirect?: string;
  error?: string;
}

function reasonHeading(result: Failure): string {
  switch (result.reason) {
    case "denied":
      return "Sign-in was cancelled";
    case "state_mismatch":
    case "invalid_callback":
      return "That sign-in link didn't check out";
    case "iss_mismatch":
      return "We couldn't verify the sign-in provider";
    case "as_error":
    case "server_error":
    default:
      return "Sign-in couldn't be completed";
  }
}

export function OAuthCallback() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ranRef = useRef(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      const result = await resolveOAuthCallback({
        code: searchParams.get("code"),
        state: searchParams.get("state"),
        iss: searchParams.get("iss"),
        error: searchParams.get("error"),
        errorDescription: searchParams.get("error_description"),
      });

      if (!result.ok) {
        setFailure(result);
        return;
      }

      // __Host-rs_session just landed on this origin. Finish exactly like the
      // magic-link lane: match the verified email to a membership, mint the
      // Supabase session, then go where that handoff says to go.
      try {
        const res = await fetch("/api/auth/regenos/session", { method: "POST" });
        const data = (await res.json()) as SessionResponse;
        if (!res.ok || !data.ok) {
          setFailure({
            ok: false,
            reason: "server_error",
            message: data.error ?? "Couldn't finish signing you in.",
          });
          return;
        }
        router.push(data.redirect ?? (data.member ? "/portal" : "/membership"));
        router.refresh();
      } catch {
        setFailure({
          ok: false,
          reason: "server_error",
          message: "Couldn't reach RegenHub. Try again in a moment.",
        });
      }
    })();
  }, [searchParams, router]);

  if (!failure) {
    return (
      <div className="glass-panel-strong p-8 text-center space-y-2">
        <p className="text-sm text-muted">Signing you in…</p>
      </div>
    );
  }

  return (
    <div className="glass-panel-strong p-8 text-center space-y-4">
      <h1 className="text-2xl font-bold text-forest">{reasonHeading(failure)}</h1>
      <p className="text-sm text-muted">{failure.message}</p>
      <a href="/auth/login" className="btn-primary-glass inline-block px-6 py-2">
        Try again
      </a>
    </div>
  );
}
