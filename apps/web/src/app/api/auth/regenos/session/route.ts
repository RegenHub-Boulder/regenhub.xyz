import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";
import { fetchRegenosIdentity, type RegenosIdentity } from "@/lib/regenos/auth";
import { syntheticEmailForDid } from "@/lib/regenos/syntheticEmail";
import { writeDid } from "@/lib/regenos/writeDid";

/**
 * POST /api/auth/regenos/session — the one-login handoff.
 *
 * The caller already holds a live regenOS session cookie on this origin (set
 * by the /xrpc proxy). This route turns that into a RegenHub session:
 *
 *   1. ask regenOS who the caller is (DID + optional VERIFIED login-anchor
 *      email — see lib/regenos/auth.ts for why that email is trustworthy);
 *   2. match a `members` row by that verified email, or (if none) by
 *      `members.did`. Unverified email and handle never claim a row;
 *   3. write `members.did` — server-side only. This is deliberately NOT the
 *      profile whitelist (api/portal/profile/route.ts:63-65 says not to add
 *      columns unless they're safe for self-edit; a custodial DID isn't);
 *   4. mint a real Supabase session so every RLS policy, every
 *      `auth.getUser()` call site and the whole portal keep working untouched.
 *
 * NO MEMBER MATCH IS NOT AN ERROR. Anyone may hold a regenOS account; a
 * session with no `members` row is a *participant* — a valid signed-in person
 * with access to public features only. We mint their session, write no member
 * row, and send them to /membership. That is Aaron's participants tier, and
 * handling it explicitly is the point.
 *
 * NO VERIFIED EMAIL IS ALSO NOT AN ERROR. A BYOD / passkey regenOS account
 * has no login-anchor email. Possession proof is the session cookie. If
 * `members.did` already points at them, they get a member session (minted
 * against the member's RegenHub email). Otherwise they get a participant
 * session minted against a synthetic `@did.regenhub.invalid` address. Linking
 * a DID onto an existing member is POST /api/auth/regenos/link — both
 * sessions at once, from the portal card.
 *
 * ── On minting the Supabase session ──────────────────────────────────────────
 * The repo's precedent for server-side identity provisioning is
 * `admin.auth.signInWithOtp({ shouldCreateUser: true })` (api/freeday/route.ts:248,
 * api/webhooks/stripe/route.ts:743, lib/passFulfillment.ts:205). We can't use it
 * verbatim: it EMAILS a magic link, and a second email is exactly what one-login
 * exists to remove. So we do the same thing without the email —
 * `generateLink` (admin API, sends nothing, returns the hashed token) redeemed
 * immediately by `verifyOtp`, which writes the `sb-regenhub` cookies through
 * the server client's cookie adapter. Provisioning via `createUser` with
 * `email_confirm: true` is honest here: regenOS just proved possession.
 *
 * Flag off ⇒ 404. The Supabase OTP door is untouched either way.
 */

type MemberHit = { id: number; email: string | null; did: string | null; disabled: boolean };

export async function POST(request: Request) {
  if (!isRegenosLoginEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const identity = await fetchRegenosIdentity(cookieHeader);
  if (!identity) {
    return NextResponse.json(
      { error: "No regenOS session. Sign in with regenOS first." },
      { status: 401 },
    );
  }

  const admin = createServiceClient();

  const found = await findMember(admin, identity);
  if (!found.ok) return found.response;
  const member = found.member;

  // ── 3. write members.did ───────────────────────────────────────────────────
  if (member) {
    if (member.did && member.did !== identity.did) {
      // One member row, two regenOS identities. A human has to decide which
      // one is real — email match and a prior DID-link disagree.
      console.warn(
        `[regenOS] member ${member.id} already linked to ${member.did}, refusing to relink to ${identity.did}`,
      );
      return NextResponse.json(
        {
          error:
            "This membership is already linked to a different regenOS identity. Email us and we'll sort it out.",
        },
        { status: 409 },
      );
    }

    if (!member.did) {
      const linked = await writeDid(admin, member.id, identity.did);
      if (!linked.ok) return linked.response;
    }
  }

  // ── 4. mint the Supabase session ───────────────────────────────────────────
  // Member email wins (that's the RegenHub account). Verified regenOS email
  // next. Synthetic DID address last — participants with no email at all.
  const mintEmail = member?.email ?? identity.email ?? syntheticEmailForDid(identity.did);

  // When no auth.users row exists yet, current GoTrue does NOT error here — it
  // auto-creates an unconfirmed user and mints a `signup`-type token (older
  // GoTrue 404s instead, which the branch below handles). Either way trigger
  // 004 links the new auth user to the member row by email on insert, so
  // supabase_user_id lands for free when the emails match. The redeem must use
  // the `verification_type` GoTrue says it minted: redeeming a signup token as
  // "magiclink" fails with "Email link is invalid or has expired", which used
  // to break exactly the first sign-in of every newly provisioned member.
  let link = await admin.auth.admin.generateLink({ type: "magiclink", email: mintEmail });

  if (link.error) {
    const { error: createError } = await admin.auth.admin.createUser({
      email: mintEmail,
      email_confirm: true,
    });
    if (createError) {
      console.error("[regenOS] auth user provisioning failed:", createError);
      return NextResponse.json({ error: "Couldn't create your sign-in." }, { status: 500 });
    }
    link = await admin.auth.admin.generateLink({ type: "magiclink", email: mintEmail });
  }

  const tokenHash = link.data?.properties?.hashed_token;
  const verificationType = link.data?.properties?.verification_type;
  if (link.error || !tokenHash || !verificationType) {
    console.error("[regenOS] generateLink failed:", link.error);
    return NextResponse.json({ error: "Couldn't create your sign-in." }, { status: 500 });
  }

  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: verificationType as "magiclink" | "signup",
    token_hash: tokenHash,
  });
  if (verifyError) {
    console.error("[regenOS] verifyOtp failed:", verifyError);
    return NextResponse.json({ error: "Couldn't start your session." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    /** false = participant: a real session, public features only. */
    member: !!member,
    did: identity.did,
    redirect: member ? "/portal" : "/membership",
  });
}

async function findMember(
  admin: ReturnType<typeof createServiceClient>,
  identity: RegenosIdentity,
): Promise<{ ok: true; member: MemberHit | null } | { ok: false; response: NextResponse }> {
  if (identity.email) {
    const { data, error } = await admin
      .from("members")
      .select("id, email, did, disabled")
      .eq("email", identity.email)
      .maybeSingle();
    if (error) {
      console.error("[regenOS] member lookup failed:", error);
      return {
        ok: false,
        response: NextResponse.json({ error: "Couldn't look up your membership." }, { status: 500 }),
      };
    }
    if (data) return { ok: true, member: data as MemberHit };
  }

  const { data, error } = await admin
    .from("members")
    .select("id, email, did, disabled")
    .eq("did", identity.did)
    .maybeSingle();
  if (error) {
    console.error("[regenOS] member did lookup failed:", error);
    return {
      ok: false,
      response: NextResponse.json({ error: "Couldn't look up your membership." }, { status: 500 }),
    };
  }
  return { ok: true, member: (data as MemberHit | null) ?? null };
}
