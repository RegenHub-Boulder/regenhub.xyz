import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, techneLinkEmail } from "@/lib/email";
import { siteOrigin } from "@/lib/techne/config";
import { doorOff, later, newLinkCode, notFound, requireTechne } from "@/lib/techne/portalDoor";
import { sameSiteJson, tooMany, withinIpLimit } from "@/lib/techne/guard";
import { LINK_PATH } from "@/lib/techne/linkPath";
import { stagingOutbox } from "@/lib/staging/outbox";

/**
 * POST /api/auth/techne/link { email } — "link the Techne account I'm signed in with to my membership".
 *
 * Proof of the Techne account: this browser's Techne sign-in (set only by /techne/callback, after this server's
 * own code exchange). Proof of the membership: a single-use link emailed to the email ON THE MEMBER ROW
 * (begin_techne_link matches it; the Techne account's own email, if any, is never read). The link only works from
 * the same Techne account (confirm_techne_link checks the DID), so a member who clicks a link someone else asked
 * for links nothing.
 *
 * Same answer whether or not a member has that email (no account probing), and the email goes out after the
 * answer, so the timing doesn't tell either. Limits: 10 asks an hour per IP; in SQL, 3 an hour per Techne account
 * (429), and at most 10 link emails an hour per member and 30 in all (both silent, so they can't be probed).
 */
export async function POST(request: Request) {
  if (doorOff()) return notFound();
  const refused = sameSiteJson(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Enter the email on your membership." }, { status: 400 });
  }
  const admin = createServiceClient();
  const signedIn = await requireTechne(admin);
  if (!signedIn.ok) return signedIn.response;
  if (!(await withinIpLimit(admin, request, "link"))) return tooMany();

  const { code, hash } = newLinkCode();
  const { data, error } = await admin.rpc("begin_techne_link", { p_did: signedIn.who.did, p_email: email, p_code_hash: hash });
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
    const to = row.member_email;
    const mail = techneLinkEmail({ name: row.member_name ?? "", link: `${siteOrigin()}${LINK_PATH}?code=${code}` });
    later(async () => {
      if (!(await sendEmail({ to, ...mail }))) stagingOutbox(to, mail);
    });
  } else {
    console.info(`[techne door] link ask for ${signedIn.who.did}: ${row.status} (nothing sent)`);
  }
  return NextResponse.json({ status: "sent" });
}
