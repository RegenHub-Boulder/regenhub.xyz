import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { publicDirectory, type PublicMember } from "@/lib/memberDirectory";

/**
 * GET /api/members/directory — the public member directory (lib/memberDirectory.ts): listed members only, and only
 * the `PublicMember` fields. Read by the landing page's member section.
 */

export type DirectoryMember = PublicMember;

export const dynamic = "force-dynamic";

/** `?limit=N` (1–100) reads only the first N members (the landing page shows six). */
export async function GET(request: Request) {
  const raw = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : undefined;
  try {
    const members = await publicDirectory(createServiceClient(), limit);
    return NextResponse.json({ members });
  } catch (error) {
    console.error("[Directory] read failed:", error);
    return NextResponse.json({ members: [] });
  }
}
