"use client";

/**
 * RSVP on an event's page, with "Sign in with Techne" as the door.
 *
 * The server holds the Techne session (one door, one sign-in): this panel asks GET /api/techne/rsvp whether this
 * browser is signed in and what the person said before, and "I'm going" / "Can't make it" POST there; the server
 * writes the person's own `community.lexicon.calendar.rsvp` on their PDS and hints the platform. Signed out: the
 * shared "Sign in with Techne" button, which comes back to this page.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { goingLine, type RsvpStatus } from "@/lib/techne/rsvp";
import { SignInWithTechne, SignOutOfTechne } from "@/components/techne/SignInWithTechne";

interface Props {
  event: { uri: string; cid: string };
  going: number;
  /** This page's path: where sign-in comes back to. */
  path: string;
}

type Mine = { rkey: string; status: RsvpStatus | null } | null;
type State = { phase: "loading" } | { phase: "signed-out" } | { phase: "unavailable" } | { phase: "signed-in"; own: Mine };

export function RsvpPanel({ event, going, path }: Props) {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/techne/rsvp?event=${encodeURIComponent(event.uri)}`, { cache: "no-store" });
    const out = (await res.json().catch(() => ({}))) as { signedIn?: boolean; own?: Mine; error?: string };
    if (!res.ok) {
      // Still signed in (the server kept it); Techne just didn't answer. No sign-in button: it would fail too.
      setError(res.status === 503 ? "Couldn't reach Techne just now. Reload in a moment." : (out.error ?? "Couldn't load your RSVP."));
      setState({ phase: "unavailable" });
      return;
    }
    setState(out.signedIn ? { phase: "signed-in", own: out.own ?? null } : { phase: "signed-out" });
  }, [event.uri]);

  useEffect(() => {
    load().catch(() => {
      setError("Couldn't load your RSVP. Reload to try again.");
      setState({ phase: "unavailable" });
    });
  }, [load]);

  async function answer(status: RsvpStatus) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/techne/rsvp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event, status, ...(own?.rkey ? { rkey: own.rkey } : {}) }),
      });
      const out = (await res.json().catch(() => ({}))) as { rkey?: string; error?: string };
      if (res.status === 401) {
        setState({ phase: "signed-out" });
        throw new Error(out.error ?? "Sign in with Techne again.");
      }
      if (!res.ok || !out.rkey) throw new Error(out.error ?? "Couldn't save your RSVP.");
      setState({ phase: "signed-in", own: { rkey: out.rkey, status } });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your RSVP.");
    } finally {
      setSaving(false);
    }
  }

  const own = state.phase === "signed-in" ? state.own : null;
  const isGoing = own?.status === "going";

  return (
    <div className="glass-panel p-6 md:p-8 text-center space-y-4" data-testid="rsvp-panel">
      <h2 className="text-xl font-semibold">RSVP</h2>
      <p className="flex items-center justify-center gap-2 text-sm text-muted" data-testid="rsvp-count">
        <Users className="w-4 h-4 text-sage" />
        {goingLine({ going })}
      </p>

      {state.phase === "loading" && <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted" aria-label="Loading" />}

      {state.phase === "signed-out" && <SignInWithTechne next={path} />}

      {state.phase === "signed-in" && (
        <div className="space-y-3">
          {isGoing ? (
            <p className="flex items-center justify-center gap-2 font-medium text-sage" data-testid="rsvp-mine">
              <Check className="w-5 h-5" /> You&apos;re going
            </p>
          ) : own?.status === "notgoing" ? (
            <p className="text-sm text-muted" data-testid="rsvp-mine">You said you can&apos;t make it.</p>
          ) : null}
          <Button
            disabled={saving}
            onClick={() => void answer(isGoing ? "notgoing" : "going")}
            className={isGoing ? "btn-glass px-6" : "btn-primary-glass px-6"}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : isGoing ? "Can't make it" : "I'm going"}
          </Button>
          <div>
            <SignOutOfTechne next={path} />
          </div>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
