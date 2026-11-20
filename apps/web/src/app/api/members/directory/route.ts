import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { publicDirectory, type PublicMember } from "@/lib/memberDirectory";

/**
 * GET /api/members/directory — the public member directory (lib/memberDirectory.ts): listed members only, and only
 * the `PublicMember` fields. Read by the landing page's member section.
 */

export type DirectoryMember = PublicMember;

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const members = await publicDirectory(createServiceClient());
    return NextResponse.json({ members });
  } catch (error) {
    console.error("[Directory] read failed:", error);
    return NextResponse.json({ members: [] });
  }
}
