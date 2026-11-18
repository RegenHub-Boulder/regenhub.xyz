import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, techneLinkEmail } from "@/lib/email";
import { siteOrigin } from "@/lib/techne/config";
import { doorOff, newLinkCode, notFound, spendProof } from "@/lib/techne/portalDoor";
import { LINK_PATH } from "@/lib/techne/linkPath";
import { stagingOutbox } from "@/lib/staging/outbox";

/**
 * POST /api/auth/techne/link { token, email } — "link this Techne account to my membership".
 *
 * Proof of the Techne account: a fresh service-auth proof (the DID). Proof of the membership: a single-use
 * link emailed to the email ON THE MEMBER ROW (begin_techne_link matches it; the Techne account's own email,
 * if any, is never read). The link only works from the same Techne account (confirm_techne_link checks the
 * DID), so a member who clicks a link someone else asked for links nothing.
 *
 * Same answer whether or not a member has that email (no account probing). Rate-limited in SQL: 3 asks an
 * hour per Techne account and per member.
 */
export async function POST(request: Request) {
  if (doorOff()) return notFound();
  const body = (await request.json().catch(() => null)) as { token?: unknown; email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Enter the email on your membership." }, { status: 400 });
  }
  const admin = createServiceClient();
  const proof = await spendProof(admin, body?.token);
  if (!proof.ok) return proof.response;

  const { code, hash } = newLinkCode();
  const { data, error } = await admin.rpc("begin_techne_link", { p_did: proof.did, p_email: email, p_code_hash: hash });
  const row = (Array.isArray(data) ? data[0] : data) as
    | { status: string; member_id: number | null; member_email: string | null; member_name: string | null }
    | undefined;
  if (error || !row) {
    console.error("[techne door] begin_techne_link failed:", error);
    return NextResponse.json({ error: "Couldn't send the link just now. Try again." }, { status: 500 });
  }
  if (row.status === "rate_limited") {
    return NextResponse.json({ error: "That's a few links already. Try again in an hour." }, { status: 429 });
  }
  if (row.status === "linked") return NextResponse.json({ status: "linked" });
  if (row.status === "sent" && row.member_email) {
    const mail = techneLinkEmail({
      name: row.member_name ?? "",
      link: `${siteOrigin()}${LINK_PATH}?code=${code}`,
      handle: proof.handle,
    });
    const sent = await sendEmail({ to: row.member_email, ...mail });
    if (!sent) stagingOutbox(row.member_email, mail);
  } else {
    console.info(`[techne door] link ask for ${proof.did}: ${row.status} (nothing sent)`);
  }
  return NextResponse.json({ status: "sent" });
}
