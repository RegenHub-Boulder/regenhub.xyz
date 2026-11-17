import { clientMetadata } from "techne-sdk/auth";
import { techneConfig } from "@/lib/techne/config";
import { signInScope } from "@/lib/techne/session";

/**
 * regenhub.xyz as a Techne app: its atproto OAuth client metadata
 * (techne.computer/docs/building-an-app.md "Sign-in": the document's own URL is
 * the client id). Built by techne-sdk's `clientMetadata`, asking only for what
 * the door needs: the one scope list every sign-in here asks for (lib/techne/session.ts signInScope).
 * 404 while the door is off.
 */
export const dynamic = "force-dynamic";

export function GET() {
  const config = techneConfig();
  if (!config) return Response.json({ error: "NotFound" }, { status: 404 });
  const origin = new URL(config.clientId).origin;
  const doc = clientMetadata({
    clientId: config.clientId,
    clientName: "RegenHub",
    clientUri: origin,
    logoUri: `${origin}/regenhub-logo.svg`,
    redirectUris: [config.redirectUri],
    scope: signInScope(config),
    ...(config.platform ? { platform: config.platform } : {}),
  });
  return Response.json(doc, { headers: { "cache-control": "public, max-age=300" } });
}
