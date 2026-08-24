"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MAX_HANDLE,
  createCustodialAccount,
  finishSession,
  probeHandle,
  setSignupProfile,
  validateHandle,
  verifySignup,
  type HandleProbe,
} from "@/lib/regenos/signupWizard";

/**
 * <MagicLinkWizard> — the browser side of `/login?token=…`, the landing page for
 * the link regenOS emails a NEW member.
 *
 * The gap it closes: `RegenosLoginPanel`'s email door reads a `chooseHandle`
 * response as "no account — use the classic lane", but that's the AppView's
 * BETA-mode answer. Prod runs email mode, where a new address comes back
 * `checkEmail` and regenOS mails a link pointing HERE. Without this page the
 * link 404s, which is the majority path for RegenHub (most members have no
 * regenOS account yet).
 *
 * Two steps, in the order the AppView enforces (see `lib/regenos/signupWizard.ts`
 * for the wire contract and the pending-cookie story):
 *   1. `verifySignup` on mount — redeem the token, bound to the
 *      `__Host-rs_pending` cookie `beginSignup` set on this origin.
 *   2. pick a name → `setSignupProfile` → `createCustodialAccount` (this is
 *      what lands the real session cookie) → the SAME
 *      `POST /api/auth/regenos/session` handoff both existing doors finish
 *      through (`RegenosLoginPanel.finish()`).
 *
 * Deliberately NOT here: the email step (that's `/auth/login`) and the contact
 * step (scenius's own post-mint surface — RegenHub already knows how to reach
 * its members). This is the shortest honest path from a clicked link to a
 * RegenHub session.
 */

/** Which view is on screen. `busy` is tracked separately so an in-flight request never yanks it. */
type Step = "verifying" | "handle" | "linkFailed";

/** Keystroke→probe debounce, in lockstep with scenius's own availability hook. */
const PROBE_DEBOUNCE_MS = 400;

export function MagicLinkWizard({ token }: { token: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("verifying");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The probe's last answer, carrying the label it ANSWERED ABOUT — that pairing
  // is what lets "are we still waiting?" be derived instead of stored (no
  // setState in an effect body, and no way for a stale answer to be shown
  // against a newer label).
  const [probe, setProbe] = useState<HandleProbe & { label: string }>({ status: "idle", label: "" });

  // The token is single-use: a second `verifySignup` would burn nothing (it's
  // already spent) but WOULD show a spurious failure, so this fires exactly
  // once even under React's development double-mount. Same ref guard as
  // <OAuthCallback>.
  const verifiedRef = useRef(false);
  useEffect(() => {
    if (verifiedRef.current) return;
    verifiedRef.current = true;
    (async () => {
      const result = await verifySignup(token);
      if (!result.ok) {
        setError(result.message);
        setStep("linkFailed");
        return;
      }
      setStep("handle");
    })();
  }, [token]);

  // The live availability probe. Only a LOCALLY VALID label is worth a
  // round-trip, and the monotonic request id means a slow answer for `ali`
  // can never overwrite a fresh one for `alice`.
  const local = validateHandle(handle);
  const probeableLabel = local.ok ? local.label : "";
  const probeId = useRef(0);
  useEffect(() => {
    if (step !== "handle" || !probeableLabel) return;
    probeId.current += 1;
    const id = probeId.current;
    const timer = setTimeout(async () => {
      const result = await probeHandle(probeableLabel);
      if (id !== probeId.current) return; // a newer keystroke won — drop this stale answer
      setProbe({ ...result, label: probeableLabel });
    }, PROBE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [probeableLabel, step]);

  // We only "have an answer" while the stored one is about the label on screen;
  // anything else means a probe is still owed (debouncing or in flight).
  const answered = probeableLabel.length > 0 && probe.label === probeableLabel;
  const checking = probeableLabel.length > 0 && !answered;
  const availability: HandleProbe = answered ? probe : { status: "idle" };

  // Submit gate, exactly scenius's: locally valid, no KNOWN collision, no probe
  // in flight, nothing already running. A probe that failed (`unknown`) is
  // NEUTRAL and never blocks — the AppView's 409 is the real backstop.
  const canSubmit = local.ok && availability.status !== "taken" && !checking && !busy;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !local.ok) return;
    setError(null);
    setBusy(true);

    const profile = await setSignupProfile(local.label);
    if (!profile.ok) {
      setError(profile.message);
      setBusy(false);
      return;
    }

    // The mint. A 409 `HandleTaken` here means the label was raced between the
    // probe and this call — stay on THIS step with the "pick another" copy
    // (the message carries the AppView's `<label>2` offer) rather than
    // bouncing someone who did nothing wrong.
    const account = await createCustodialAccount();
    if (!account.ok) {
      setError(account.message);
      setBusy(false);
      return;
    }

    // The regenOS session cookie has landed on this origin; finish the way
    // every other regenOS door finishes.
    const finished = await finishSession();
    if (!finished.ok) {
      setError(finished.message);
      setBusy(false);
      return;
    }
    router.push(finished.redirect);
    router.refresh();
    // Leave `busy` true — the navigation is taking over, and re-enabling the
    // button would invite a second mint.
  }

  if (step === "verifying") {
    return (
      <Panel>
        <p className="text-sm text-muted text-center">Confirming your link…</p>
      </Panel>
    );
  }

  if (step === "linkFailed") {
    return (
      <Panel>
        <p className="text-sm text-muted">{error}</p>
        <a href="/auth/login" className="btn-primary-glass inline-block w-full text-center px-6 py-2">
          Start again
        </a>
      </Panel>
    );
  }

  return (
    <Panel>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="regenos-handle">Pick a name for your account</Label>
          <Input
            id="regenos-handle"
            value={handle}
            // Lowercase as they type: the charset is lowercase-only, and
            // silently fixing a capital is kinder than scolding them for it.
            onChange={(e) => setHandle(e.target.value.toLowerCase())}
            placeholder="yourname"
            maxLength={MAX_HANDLE}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            disabled={busy}
            className="bg-white/10 border-white/20 text-foreground placeholder:text-muted"
          />
          <AvailabilityNote
            handle={handle}
            probe={availability}
            checking={checking}
            localMessage={local.ok ? null : local.message}
          />
        </div>
        {error && (
          <p className="text-red-400 text-sm" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={!canSubmit} className="btn-primary-glass w-full">
          {busy ? "Setting you up…" : "Finish signing in"}
        </Button>
      </form>
    </Panel>
  );
}

/**
 * The one-line note under the field. Order matters: a local problem is the
 * person's next action, so it wins over anything the probe has to say — and a
 * probe that couldn't reach the AppView says nothing at all rather than
 * implying an answer it doesn't have.
 */
function AvailabilityNote({
  handle,
  probe,
  checking,
  localMessage,
}: {
  handle: string;
  probe: HandleProbe;
  checking: boolean;
  localMessage: string | null;
}) {
  if (handle.trim().length > 0 && localMessage) {
    return <p className="text-xs text-red-400">{localMessage}</p>;
  }
  if (checking) {
    return <p className="text-xs text-muted">Checking…</p>;
  }
  if (probe.status === "free") {
    return <p className="text-xs text-forest">{probe.handle ?? handle.trim()} is available.</p>;
  }
  if (probe.status === "taken") {
    return (
      <p className="text-xs text-red-400">
        {probe.handle ?? handle.trim()} is taken.
        {probe.suggestion ? ` ${probe.suggestion} is free.` : ""}
      </p>
    );
  }
  return <p className="text-xs text-muted">Lowercase letters, numbers, and hyphens — up to {MAX_HANDLE}.</p>;
}

/** Same wrapper `RegenosLoginPanel` uses, so both regenOS surfaces sit identically in the page's card. */
function Panel({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4">{children}</div>;
}
