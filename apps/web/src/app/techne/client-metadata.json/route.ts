import { techneConfig } from "@/lib/techne/config";
import { clientMetadataDoc } from "@/lib/techne/oauth/client";

/**
 * regenhub.xyz as a Techne app: its atproto OAuth client metadata (the document's own URL is the client id). A
 * confidential client: `private_key_jwt` with the keys at /techne/jwks.json, DPoP-bound tokens, the one scope list
 * every sign-in here asks for (lib/techne/session.ts signInScope), and this server's callback. 404 while the door
 * is off.
 */
export const dynamic = "force-dynamic";

export function GET() {
  const config = techneConfig();
  if (!config) return Response.json({ error: "NotFound" }, { status: 404 });
  return Response.json(clientMetadataDoc(config), { headers: { "cache-control": "public, max-age=300" } });
}
