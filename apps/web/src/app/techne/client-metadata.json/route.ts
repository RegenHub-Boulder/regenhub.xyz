import { clientMetadata } from "techne-sdk/auth";
import { rsvpConfig } from "@/lib/techne/rsvpConfig";
import { RSVP_TYPES } from "@/lib/techne/rsvp";

/**
 * regenhub.xyz as a Techne app: its atproto OAuth client metadata
 * (techne.computer/docs/building-an-app.md "Sign-in": the document's own URL is
 * the client id). Built by techne-sdk's `clientMetadata`, asking only for what
 * RSVP needs. 404 while RSVP is off.
 */
export const dynamic = "force-dynamic";

export function GET() {
  const config = rsvpConfig();
  if (!config) return Response.json({ error: "NotFound" }, { status: 404 });
  const origin = new URL(config.clientId).origin;
  const doc = clientMetadata({
    clientId: config.clientId,
    clientName: "RegenHub",
    clientUri: origin,
    logoUri: `${origin}/regenhub-logo.svg`,
    redirectUris: [config.redirectUri],
    types: RSVP_TYPES,
    ...(config.platform ? { platform: config.platform } : {}),
  });
  return Response.json(doc, { headers: { "cache-control": "public, max-age=300" } });
}
