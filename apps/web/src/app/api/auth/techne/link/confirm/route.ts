import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { mintSupabaseSession } from "@/lib/auth/mintSession";
import { sendEmail, techneLinkedEmail } from "@/lib/email";
import { siteOrigin } from "@/lib/techne/config";
import { doorOff, hashLinkCode, later, notFound, requireTechne } from "@/lib/techne/portalDoor";
import { sameSiteJson, tooMany, withinIpLimit } from "@/lib/techne/guard";
import { stagingOutbox } from "@/lib/staging/outbox";

/**
 * POST /api/auth/techne/link/confirm { code } — redeem the emailed link. Needs this browser signed in with the same
 * Techne account that asked; confirm_techne_link writes members.did and the `techne_did_linked` audit row in one
 * transaction. The member is emailed that a Techne account was linked (with where to unlink it), then the portal
 * session starts.
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
  const refused = sameSiteJson(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(code)) return NextResponse.json({ error: REFUSALS.invalid[1] }, { status: 410 });
  const admin = createServiceClient();
  const signedIn = await requireTechne(admin);
  if (!signedIn.ok) return signedIn.response;
  if (!(await withinIpLimit(admin, request, "confirm"))) return tooMany();

  const { did, handle } = signedIn.who;
  const { data, error } = await admin.rpc("confirm_techne_link", { p_code_hash: hashLinkCode(code), p_did: did });
  const row = (Array.isArray(data) ? data[0] : data) as
    | { status: string; member_email: string | null; member_name: string | null; newly: boolean }
    | undefined;
  if (error || !row) {
    console.error("[techne door] confirm_techne_link failed:", error);
    return NextResponse.json({ error: "Couldn't link just now. Try again." }, { status: 500 });
  }
  if (row.status !== "linked" || !row.member_email) {
    const [status, message] = REFUSALS[row.status] ?? REFUSALS.invalid;
    return NextResponse.json({ error: message, status: row.status }, { status });
  }
  if (row.newly) {
    const to = row.member_email;
    const mail = techneLinkedEmail({ name: row.member_name ?? "", account: handle ? `@${handle} (${did})` : did, profile: `${siteOrigin()}/portal/profile` });
    later(async () => {
      if (!(await sendEmail({ to, ...mail }))) stagingOutbox(to, mail);
    });
  }
  const minted = await mintSupabaseSession(admin, row.member_email, "techne door");
  if (!minted.ok) return NextResponse.json({ error: minted.error }, { status: 500 });
  return NextResponse.json({ member: true, did, handle });
}
