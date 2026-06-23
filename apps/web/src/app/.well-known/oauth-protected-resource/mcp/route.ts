import { protectedResourceMetadata } from "@/lib/mcp/metadata";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(protectedResourceMetadata(), {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
  });
}
