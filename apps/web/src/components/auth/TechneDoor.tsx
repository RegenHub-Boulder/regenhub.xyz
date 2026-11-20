/**
 * The one door: "Sign in with Techne" on /auth/login and /apply. One sign-in gives this browser the Techne session
 * (RSVP, posting, held by the server) and, when the account is a member's, the portal session; both start in the
 * server's own callback (app/techne/callback/route.ts). The email link stays as a quiet fallback, never a peer button.
 *
 *   not signed in with Techne      the button, then "Use an email link instead"
 *   signed in, account linked      the button again (the portal session starts only from a fresh sign-in)
 *   signed in, account not linked  link it (email link to the member email) or become a member
 *
 * Server component: who is signed in with Techne is this site's own cookie (lib/techne/webSession.ts).
 */

import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/admin";
import { currentTechne } from "@/lib/techne/webSession";
import { shortDid } from "@/lib/techne/did";
import { memberForDid } from "@/lib/techne/portalDoor";
import { STEWARD_PATH } from "@/lib/techne/session";
import { SignInWithTechne, SignOutOfTechne } from "@/components/techne/SignInWithTechne";
import { LoginForm } from "@/components/auth/LoginForm";
import { LinkMembershipForm } from "@/components/auth/LinkMembershipForm";

interface Props {
  /** Where a member goes once in (already checked by safeNextPath). */
  next: string;
  /** An email-link error (/auth/callback): opens the email fallback with it. */
  banner?: string | null;
  /** A Techne sign-in that didn't finish (/techne/callback, /techne/signin). */
  techneError?: string | null;
  /** /apply: a visitor who isn't a member applies with an email link (applications need a reachable email). */
  mode?: "login" | "apply";
}

export async function TechneDoor({ next, banner = null, techneError = null, mode = "login" }: Props) {
  const admin = createServiceClient();
  const who = await currentTechne(admin);
  const linked = who ? await memberForDid(admin, who.did) : null;

  if (who && linked?.ok && !linked.member) {
    return <NotLinked did={who.did} handle={who.handle} mode={mode} next={next} />;
  }

  return (
    <div className="space-y-6 text-center" data-testid="techne-door">
      {techneError && (
        <p className="text-sm text-red-300" role="alert">
          {techneError}
        </p>
      )}
      <SignInWithTechne next={next} />
      <EmailFallback next={next} banner={banner} />
    </div>
  );
}

function EmailFallback({ next, banner }: { next: string; banner: string | null }) {
  return (
    <details className="text-left" open={!!banner}>
      <summary className="text-xs text-muted text-center cursor-pointer list-none hover:text-forest transition-colors">
        Use an email link instead
      </summary>
      <div className="mt-4">
        <LoginForm initialBanner={banner} next={next} />
      </div>
    </details>
  );
}

function NotLinked({ did, handle, mode, next }: { did: string; handle: string | null; mode: "login" | "apply"; next: string }) {
  const who = handle ? `@${handle}` : shortDid(did);
  const back = mode === "apply" ? "/apply" : `/auth/login?next=${encodeURIComponent(next)}`;
  return (
    <div className="space-y-6 text-left" data-testid="techne-not-linked">
      <p className="text-sm text-center">
        Signed in with Techne as <span className="text-forest font-medium">{who}</span>.
      </p>

      {mode === "apply" ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">Applications need an email we can reach you at. We&apos;ll send a link and bring you back here.</p>
          <LoginForm next="/apply" />
          <p className="text-xs text-muted">
            Already a member? <Link href="/auth/login?next=/portal" className="text-sage hover:underline">Link this account</Link>.
          </p>
        </div>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="font-semibold text-forest">Already a member?</h2>
            <LinkMembershipForm />
          </section>
          <section className="space-y-1">
            <h2 className="font-semibold text-forest">Not a member yet?</h2>
            <p className="text-sm text-muted">
              You can RSVP to events with this account. To use the space,{" "}
              <Link href="/membership" className="text-sage hover:underline">
                see memberships
              </Link>{" "}
              or{" "}
              <Link href="/apply" className="text-sage hover:underline">
                apply
              </Link>
              .
            </p>
          </section>
          {/* RegenHub's stewards on Techne need no membership here (/admin/events decides by the Techne role). */}
          <p className="text-xs text-muted" data-testid="steward-door">
            A facilitator or manager of RegenHub on Techne?{" "}
            <Link href={STEWARD_PATH} className="text-sage hover:underline">
              Manage events
            </Link>
            .
          </p>
        </>
      )}
      <div className="text-center">
        <SignOutOfTechne next={back} />
      </div>
    </div>
  );
}
