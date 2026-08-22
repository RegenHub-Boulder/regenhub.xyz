import { NextResponse } from "next/server";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";
import { buildClientMetadataDoc } from "@/lib/regenos/oauth";

/**
 * GET /oauth-client-metadata.json — regenhub.xyz's static atproto OAuth
 * client-metadata document.
 *
 * This document's URL IS regenhub.xyz's OAuth `client_id`, per the atproto
 * "client ID metadata document" convention. It declares this app's exact
 * `redirect_uri` (its clean `/oauth/callback`, NOT the `/xrpc` proxy path),
 * `scope`, and — once `REGENOS_OAUTH_JWKS_URI` is configured — the shared
 * AppView JWKS that makes this a confidential `private_key_jwt` client,
 * exactly like regenOS's own scenius-web/liminal-web
 * (`OAUTH_CLIENTS` on regenOS's side must register the SAME client_id +
 * redirect_uri, per `crates/regenos-appview/src/auth/oauth_client.rs`).
 *
 * Path and shape follow regenOS's own `oauth-client-metadata.json` route
 * (`apps/scenius-web/src/app/oauth-client-metadata.json/route.ts`) —
 * re-authored here, not imported, because `packages/ui` is a private
 * workspace package regenhub.xyz's repo can't reach.
 *
 * GATED ON THE FLAG, same posture as the `/xrpc` proxy: with
 * REGENOS_LOGIN_ENABLED off this 404s, so no OAuth surface is reachable
 * before the flag flips. No secrets in the document either way.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): NextResponse {
  if (!isRegenosLoginEnabled()) {
    return NextResponse.json({ error: "NotFound" }, { status: 404 });
  }
  return NextResponse.json(buildClientMetadataDoc(), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
