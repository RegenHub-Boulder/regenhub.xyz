import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { mintSupabaseSession } from "@/lib/auth/mintSession";
import { doorOff, hashLinkCode, notFound, spendProof } from "@/lib/techne/portalDoor";

/**
 * POST /api/auth/techne/link/confirm { token, code } — redeem the emailed link. Needs the same Techne account
 * that asked (a fresh proof); confirm_techne_link writes members.did and the `techne_did_linked` audit row in
 * one transaction. Then the member's portal session starts.
 */
const REFUSALS: Record<string, [number, string]> = {
  wrong_account: [
    403,
    "This link was asked for from a different Techne account. Sign in with that account, or ask for a new link.",
  ],
  used: [410, "This link was already used. Sign in with Techne to continue."],
  expired: [410, "This link expired. Ask for a new one from the sign-in page."],
  invalid: [410, "This link doesn't work. Ask for a new one from the sign-in page."],
  taken: [409, "This membership is already linked to a different Techne account. Email us and we'll sort it out."],
};

export async function POST(request: Request) {
  if (doorOff()) return notFound();
  const body = (await request.json().catch(() => null)) as { token?: unknown; code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(code)) return NextResponse.json({ error: REFUSALS.invalid[1] }, { status: 410 });
  const admin = createServiceClient();
  const proof = await spendProof(admin, body?.token);
  if (!proof.ok) return proof.response;

  const { data, error } = await admin.rpc("confirm_techne_link", { p_code_hash: hashLinkCode(code), p_did: proof.did });
  const row = (Array.isArray(data) ? data[0] : data) as { status: string; member_email: string | null } | undefined;
  if (error || !row) {
    console.error("[techne door] confirm_techne_link failed:", error);
    return NextResponse.json({ error: "Couldn't link just now. Try again." }, { status: 500 });
  }
  if (row.status !== "linked" || !row.member_email) {
    const [status, message] = REFUSALS[row.status] ?? REFUSALS.invalid;
    return NextResponse.json({ error: message, status: row.status }, { status });
  }
  const minted = await mintSupabaseSession(admin, row.member_email, "techne door");
  if (!minted.ok) return NextResponse.json({ error: minted.error }, { status: 500 });
  return NextResponse.json({ member: true, did: proof.did, handle: proof.handle });
}
