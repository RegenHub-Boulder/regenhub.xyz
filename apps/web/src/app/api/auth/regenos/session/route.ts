import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";
import { fetchRegenosIdentity } from "@/lib/regenos/auth";

/**
 * POST /api/auth/regenos/session — the one-login handoff.
 *
 * The caller already holds a live regenOS session cookie on this origin (set
 * by the /xrpc proxy). This route turns that into a RegenHub session:
 *
 *   1. ask regenOS who the caller is (DID + the VERIFIED login-anchor email —
 *      see lib/regenos/auth.ts for why that email is trustworthy);
 *   2. match that email to a `members` row — the SAME email join the four
 *      existing stitching mechanisms already use (triggers 004/013/020 and the
 *      portal's runtime repair, CLAUDE.md "Identity linkage");
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
 * ── On minting the Supabase session ──────────────────────────────────────────
 * The repo's precedent for server-side identity provisioning is
 * `admin.auth.signInWithOtp({ shouldCreateUser: true })` (api/freeday/route.ts:248,
 * api/webhooks/stripe/route.ts:743, lib/passFulfillment.ts:205). We can't use it
 * verbatim: it EMAILS a magic link, and a second email is exactly what one-login
 * exists to remove. So we do the same thing without the email —
 * `generateLink` (admin API, sends nothing, returns the hashed token) redeemed
 * immediately by `verifyOtp`, which writes the `sb-regenhub` cookies through
 * the server client's cookie adapter. Provisioning via `createUser` with
 * `email_confirm: true` is honest here: regenOS just proved the address.
 *
 * Flag off ⇒ 404. The Supabase OTP door is untouched either way.
 */
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

  if (!identity.email) {
    // A BYOD / passkey regenOS account has no email anchor at all. There is
    // nothing to match on and nothing to prove, so we refuse rather than guess.
    return NextResponse.json(
      {
        error:
          "That regenOS account has no verified email, so we can't match it to a RegenHub membership.",
      },
      { status: 403 },
    );
  }

  const email = identity.email;
  const admin = createServiceClient();

  // ── 2. match the membership by verified email ──────────────────────────────
  const { data: member, error: memberError } = await admin
    .from("members")
    .select("id, email, did, disabled")
    .eq("email", email)
    .maybeSingle();

  if (memberError) {
    console.error("[regenOS] member lookup failed:", memberError);
    return NextResponse.json({ error: "Couldn't look up your membership." }, { status: 500 });
  }

  // ── 3. write members.did ───────────────────────────────────────────────────
  if (member) {
    if (member.did && member.did !== identity.did) {
      // One member row, two regenOS identities. regenOS's own email→DID map is
      // a bijection, so this only happens if the member's email was changed
      // after a previous link. A human has to decide which one is real.
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
      const { error: linkError } = await admin
        .from("members")
        .update({ did: identity.did })
        .eq("id", member.id);

      if (linkError) {
        // 23505 = the unique index caught another member already holding this
        // DID. Same friendly-409 posture as the telegram handle
        // (api/portal/profile/route.ts:78-86).
        if ((linkError as { code?: string }).code === "23505") {
          return NextResponse.json(
            {
              error:
                "That regenOS identity is already linked to another member. Email us and we'll sort it out.",
            },
            { status: 409 },
          );
        }
        console.error("[regenOS] did link failed:", linkError);
        return NextResponse.json({ error: "Couldn't link your regenOS identity." }, { status: 500 });
      }
    }
  }

  // ── 4. mint the Supabase session ───────────────────────────────────────────
  let link = await admin.auth.admin.generateLink({ type: "magiclink", email });

  if (link.error) {
    // No auth.users row yet — provision one. Trigger 004 links it to the
    // member row by email on insert, so supabase_user_id lands for free.
    const { error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createError) {
      console.error("[regenOS] auth user provisioning failed:", createError);
      return NextResponse.json({ error: "Couldn't create your sign-in." }, { status: 500 });
    }
    link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  }

  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) {
    console.error("[regenOS] generateLink failed:", link.error);
    return NextResponse.json({ error: "Couldn't create your sign-in." }, { status: 500 });
  }

  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: "magiclink",
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
