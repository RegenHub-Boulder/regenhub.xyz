import { techneConfig } from "@/lib/techne/config";
import { publicJwks } from "@/lib/techne/oauth/client";

/**
 * The public half of regenhub.xyz's OAuth client key (its client metadata's `jwks_uri`): the PDS checks our
 * `private_key_jwt` client assertions against it. 404 while the door is off; empty on the staging stand-in.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const config = techneConfig();
  if (!config) return Response.json({ error: "NotFound" }, { status: 404 });
  if (config.standIn) return Response.json({ keys: [] });
  return Response.json(await publicJwks(), { headers: { "cache-control": "public, max-age=300" } });
}
