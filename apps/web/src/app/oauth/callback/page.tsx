import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { OAuthCallback } from "@/components/auth/OAuthCallback";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";

/**
 * `/oauth/callback` — regenhub.xyz's clean atproto OAuth redirect target
 * (the EXACT-match registered `redirect_uri`, not the `/xrpc` proxy path).
 *
 * The PDS lands the browser here after consent with `code`/`state`/`iss`.
 * The client <OAuthCallback> hands those to the AppView via the same-origin
 * `/xrpc` proxy, which lands `__Host-rs_session` on this origin, then runs
 * the SAME downstream logic the magic-link lane uses
 * (`POST /api/auth/regenos/session`) before navigating on.
 *
 * Server wrapper (so the flag gate + metadata are server-side) over the
 * client island, which needs a Suspense boundary because it reads
 * `useSearchParams`. Pattern follows regenOS's own `apps/scenius-web/src/
 * app/oauth/callback/page.tsx`.
 *
 * Gated the same way every other regenOS-login surface in this app is: with
 * REGENOS_LOGIN_ENABLED off, this route 404s rather than rendering a dead
 * end (the PDS would never redirect here in the first place, since
 * `/oauth-client-metadata.json` — the thing that gets this app registered
 * as an OAuth client at all — is 404ing too).
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Signing in — RegenHub",
  robots: { index: false, follow: false },
};

export default function OAuthCallbackPage() {
  if (!isRegenosLoginEnabled()) {
    notFound();
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <Suspense fallback={null}>
          <OAuthCallback />
        </Suspense>
      </div>
    </div>
  );
}
