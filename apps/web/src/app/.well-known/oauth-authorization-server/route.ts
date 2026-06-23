import { authServerMetadata } from "@/lib/mcp/metadata";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(authServerMetadata(), {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
  });
}
