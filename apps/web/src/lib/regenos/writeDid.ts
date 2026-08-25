import { NextResponse } from "next/server";
import type { createServiceClient } from "@/lib/supabase/admin";

/**
 * Server-side `members.did` write. Not on the profile whitelist — a custodial
 * DID isn't self-editable. 23505 → friendly 409, same as telegram handle.
 */
export async function writeDid(
  admin: ReturnType<typeof createServiceClient>,
  memberId: number,
  did: string,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const { error } = await admin.from("members").update({ did }).eq("id", memberId);
  if (!error) return { ok: true };
  if ((error as { code?: string }).code === "23505") {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "That regenOS identity is already linked to another member. Email us and we'll sort it out.",
        },
        { status: 409 },
      ),
    };
  }
  console.error("[regenOS] did link failed:", error);
  return {
    ok: false,
    response: NextResponse.json({ error: "Couldn't link your regenOS identity." }, { status: 500 }),
  };
}
