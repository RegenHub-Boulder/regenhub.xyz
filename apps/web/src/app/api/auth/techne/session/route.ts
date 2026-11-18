import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { mintSupabaseSession } from "@/lib/auth/mintSession";
import { doorOff, memberForDid, notFound, spendProof } from "@/lib/techne/portalDoor";

/**
 * POST /api/auth/techne/session { token } — the one door's handoff. Called right after "Sign in with Techne"
 * (and on /auth/login when a Techne session is already there) with a fresh atproto service-auth proof
 * (lib/techne/portalAuth.ts).
 *
 * A DID linked to a member (members.did) gets that member's portal session, minted server-side. Any other DID
 * gets no portal session: `{ member: false }`, and the page offers to link the account (proved by an email
 * link to the member email: POST /api/auth/techne/link) or to become a member. The Techne session itself
 * (RSVP, posting) lives in the browser and is not this route's business.
 */
export async function POST(request: Request) {
  if (doorOff()) return notFound();
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const admin = createServiceClient();
  const proof = await spendProof(admin, body?.token);
  if (!proof.ok) return proof.response;

  const found = await memberForDid(admin, proof.did);
  if (!found.ok) return found.response;
  const member = found.member;
  if (!member) return NextResponse.json({ member: false, did: proof.did, handle: proof.handle });
  if (!member.email) {
    return NextResponse.json(
      { error: "Your membership has no email on file, so the portal can't open. Email us and we'll fix it." },
      { status: 409 },
    );
  }
  const minted = await mintSupabaseSession(admin, member.email, "techne door");
  if (!minted.ok) return NextResponse.json({ error: minted.error }, { status: 500 });
  return NextResponse.json({ member: true, did: proof.did, handle: proof.handle });
}
