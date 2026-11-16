"use client";

/**
 * RSVP on the event's own page, with a Techne account.
 *
 * Signed out: "Sign in to RSVP" → /auth/login?next=<this page>. The login lane
 * makes a techne.town account for a first-timer (email link) and lands the
 * Techne session on this origin, then brings them back here.
 * Signed in: "I'm going" / "Can't make it", via `social.scenius.rsvp` through
 * the same-origin /xrpc proxy (lib/regenos/rsvp.ts says what it writes).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { attendanceQuery, buildRsvpInput, goingLine, seatLabel, type RsvpIntent } from "@/lib/regenos/rsvp";

interface Props {
  event: { did: string; rkey: string };
  attendance: { going: number; waitlisted: number; maxAttendees: number | null };
  /** This page's path, to come back to after sign-in. */
  path: string;
}

type Phase = "checking" | "signed-out" | "ready" | "saving";

export function RsvpPanel({ event, attendance, path }: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("checking");
  const [handle, setHandle] = useState<string | null>(null);
  const [seat, setSeat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSeat = useCallback(async () => {
    const res = await fetch(`/xrpc/social.scenius.getEventAttendance?${attendanceQuery(event)}`, { cache: "no-store" });
    if (res.ok) setSeat(((await res.json()) as { mySeat?: string | null }).mySeat ?? null);
  }, [event]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/xrpc/social.scenius.getSession", { cache: "no-store" });
        if (!live) return;
        if (!res.ok) return setPhase("signed-out");
        const s = (await res.json()) as { did?: string; handle?: string };
        if (!s.did) return setPhase("signed-out");
        setHandle(s.handle ?? s.did);
        await loadSeat().catch(() => {});
        if (live) setPhase("ready");
      } catch {
        if (live) setPhase("signed-out");
      }
    })();
    return () => {
      live = false;
    };
  }, [loadSeat]);

  async function answer(intent: RsvpIntent) {
    setPhase("saving");
    setError(null);
    try {
      const res = await fetch("/xrpc/social.scenius.rsvp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildRsvpInput(event, intent)),
      });
      const out = (await res.json().catch(() => ({}))) as { state?: string; message?: string };
      if (!res.ok) throw new Error(out.message ?? `RSVP failed (${res.status})`);
      setSeat(intent === "notgoing" ? "declined" : (out.state ?? null));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your RSVP.");
    } finally {
      setPhase("ready");
    }
  }

  const going = seat === "confirmed" || seat === "waitlisted" || seat === "requested";
  const label = seatLabel(seat);

  return (
    <div className="glass-panel p-6 md:p-8 text-center space-y-4" data-testid="rsvp-panel">
      <h2 className="text-xl font-semibold">RSVP</h2>
      <p className="flex items-center justify-center gap-2 text-sm text-muted" data-testid="rsvp-count">
        <Users className="w-4 h-4 text-sage" />
        {goingLine(attendance)}
      </p>

      {phase === "checking" && <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted" aria-label="Loading" />}

      {phase === "signed-out" && (
        <div className="space-y-2 max-w-sm mx-auto">
          <Link href={`/auth/login?next=${encodeURIComponent(path)}`}>
            <Button className="btn-primary-glass px-6">Sign in to RSVP</Button>
          </Link>
          <p className="text-xs text-muted leading-relaxed">
            New here? Sign in with your email and you get a Techne account: one account for every Techne app.
          </p>
        </div>
      )}

      {(phase === "ready" || phase === "saving") && (
        <div className="space-y-3">
          {label && (
            <p className="flex items-center justify-center gap-2 font-medium text-sage" data-testid="rsvp-seat">
              {going && <Check className="w-5 h-5" />} {label}
            </p>
          )}
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {!going ? (
              <Button disabled={phase === "saving"} onClick={() => void answer("going")} className="btn-primary-glass px-6">
                {phase === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : "I'm going"}
              </Button>
            ) : (
              <Button disabled={phase === "saving"} onClick={() => void answer("notgoing")} className="btn-glass px-6">
                {phase === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Can't make it"}
              </Button>
            )}
          </div>
          {handle && <p className="text-xs text-muted">Signed in as {handle}</p>}
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
