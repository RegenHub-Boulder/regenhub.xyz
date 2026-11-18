"use client";

/**
 * The one door: "Sign in with Techne" on /auth/login and /apply. One sign-in gives the Techne session (RSVP,
 * posting) and, when the account is a member's, the portal session (lib/techne/portalClient.ts). The email link
 * stays as a quiet fallback, never a peer button.
 *
 *   signed out            the button, then "Use an email link instead"
 *   signed in, member     straight on to `next`
 *   signed in, no member  link it (email link to the member email) or become a member
 *   proof failed          sign in with Techne again (a session from before the door asked for less)
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TechneConfig } from "@/lib/techne/config";
import type { Session } from "@/lib/techne/call";
import { askLink, openPortal } from "@/lib/techne/portalClient";
import { signOutOfTechne } from "@/lib/techne/signOut";
import { useTechneSession } from "@/components/techne/useTechneSession";
import { SignInWithTechne, SignOutOfTechne } from "@/components/techne/SignInWithTechne";
import { LoginForm } from "@/components/auth/LoginForm";

type Door =
  | { state: "idle" }
  | { state: "member" }
  | { state: "not-linked"; handle: string | null; did: string }
  | { state: "failed"; error: string };

interface Props {
  config: TechneConfig;
  /** Where a member goes once in (already checked by safeNextPath). */
  next: string;
  banner?: string | null;
  /** /apply: a visitor who isn't a member applies with an email link (applications need a reachable email). */
  mode?: "login" | "apply";
  /** Just signed out (/auth/signout): end a Techne session left behind instead of signing back in. */
  signedOut?: boolean;
}

export function TechneDoor({ config, next, banner = null, mode = "login", signedOut = false }: Props) {
  const { phase, session, error, start, signOut } = useTechneSession(config, next);
  const [door, setDoor] = useState<Door>({ state: "idle" });
  const asked = useRef<string | null>(null);
  // Arriving from a sign-out with a Techne session still here (a no-JS sign-out): end it, don't sign back in.
  const clearing = signedOut && (phase === "restoring" || phase === "signed-in");

  useEffect(() => {
    if (!signedOut || phase !== "signed-in" || !session) return;
    void signOutOfTechne(config, session).finally(() => window.location.replace("/auth/login"));
  }, [signedOut, phase, session, config]);

  useEffect(() => {
    if (signedOut || phase !== "signed-in" || !session || asked.current === session.did) return;
    asked.current = session.did;
    openPortal(session as Session, config)
      .then((a) => {
        if (a.member) {
          setDoor({ state: "member" });
          window.location.replace(next);
        } else setDoor({ state: "not-linked", handle: a.handle, did: a.did });
      })
      .catch((err: unknown) =>
        setDoor({ state: "failed", error: err instanceof Error ? err.message : "Couldn't open your portal." }),
      );
  }, [signedOut, phase, session, config, next]);

  // Signed in and not answered yet: the portal check is running.
  const checking = phase === "signed-in" && !!session && door.state === "idle";

  if (clearing || checking || phase === "restoring" || door.state === "member") {
    return (
      <p className="flex items-center justify-center gap-2 py-6 text-muted" data-testid="door-busy">
        <Loader2 className="w-5 h-5 animate-spin" /> Signing you in…
      </p>
    );
  }

  if (phase === "signed-in" && session && door.state === "not-linked") {
    return (
      <NotLinked
        config={config}
        session={session as Session}
        handle={door.handle}
        mode={mode}
        next={next}
        onSignOut={() => void signOut()}
      />
    );
  }

  return (
    <div className="space-y-6 text-center" data-testid="techne-door">
      {phase === "signed-in" && door.state === "failed" ? (
        <div className="space-y-3">
          <p className="text-sm text-red-300" role="alert">
            {door.error}
          </p>
          <Button type="button" onClick={() => void start(false)} className="btn-primary-glass px-6">
            Sign in with Techne again
          </Button>
        </div>
      ) : (
        <SignInWithTechne busy={phase === "starting"} onStart={(signUp) => void start(signUp)} />
      )}
      {error && (
        <p className="text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
      <EmailFallback banner={banner} next={next} />
    </div>
  );
}

function EmailFallback({ banner, next }: { banner: string | null; next: string }) {
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

function NotLinked({
  config,
  session,
  handle,
  mode,
  next,
  onSignOut,
}: {
  config: TechneConfig;
  session: Session;
  handle: string | null;
  mode: "login" | "apply";
  next: string;
  onSignOut: () => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await askLink(session, config, email);
      if (out.status === "linked") window.location.replace(next);
      else setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the link.");
    } finally {
      setBusy(false);
    }
  }

  const who = handle ? `@${handle}` : "your Techne account";
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
            {sent ? (
              <p className="text-sm" role="status" data-testid="link-sent">
                If <strong>{email}</strong> is on a membership, a link is on its way. Open it on this device to finish.
              </p>
            ) : (
              <form onSubmit={send} className="space-y-3">
                <p className="text-sm text-muted">
                  Enter the email on your membership. We&apos;ll email a link to confirm it&apos;s you, once.
                </p>
                <Input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-label="Membership email"
                />
                <Button type="submit" disabled={busy || !email} className="btn-glass w-full">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Email me a link"}
                </Button>
                {error && (
                  <p className="text-sm text-red-300" role="alert">
                    {error}
                  </p>
                )}
              </form>
            )}
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
        </>
      )}
      <p className="text-center">
        <SignOutOfTechne onSignOut={onSignOut} />
      </p>
    </div>
  );
}
