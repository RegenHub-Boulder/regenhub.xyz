import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";
import { fetchRegenosIdentity } from "@/lib/regenos/auth";
import { writeDid } from "@/lib/regenos/writeDid";

/**
 * POST /api/auth/regenos/link — attach a regenOS DID to the logged-in member.
 *
 * Possession proof is both sessions at once: a live RegenHub (Supabase) session
 * AND a live regenOS cookie. Email is not required. This is the BYOD path:
 * you're already a member (magic-link / existing account), you sign into
 * regenOS on this origin, we write `members.did`. Unverified email still never
 * claims anyone else's row — we bind to the caller’s member row only.
 *
 * Flag off ⇒ 404.
 */
export async function POST(request: Request) {
  if (!isRegenosLoginEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const identity = await fetchRegenosIdentity(cookieHeader);
  if (!identity) {
    return NextResponse.json(
      { error: "No regenOS session. Sign in with regenOS first, then try linking again." },
      { status: 401 },
    );
  }

  const admin = createServiceClient();
  const { data: member, error: memberError } = await admin
    .from("members")
    .select("id, email, did")
    .eq("supabase_user_id", user.id)
    .maybeSingle();

  if (memberError) {
    console.error("[regenOS] link member lookup failed:", memberError);
    return NextResponse.json({ error: "Couldn't look up your membership." }, { status: 500 });
  }
  if (!member) {
    return NextResponse.json(
      { error: "Linking is for existing members. Apply to join, or sign in with a membership email." },
      { status: 403 },
    );
  }

  if (member.did && member.did !== identity.did) {
    return NextResponse.json(
      {
        error:
          "This membership is already linked to a different regenOS identity. Email us and we'll sort it out.",
      },
      { status: 409 },
    );
  }

  if (member.did === identity.did) {
    return NextResponse.json({ ok: true, did: identity.did, already: true });
  }

  const linked = await writeDid(admin, member.id, identity.did);
  if (!linked.ok) return linked.response;

  return NextResponse.json({ ok: true, did: identity.did, already: false });
}
