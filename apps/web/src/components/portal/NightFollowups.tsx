"use client";

/**
 * "Follow-ups after nights" on /admin/events (T-497): for each night that ended in the last few days, who would get a
 * short note and which one, a preview of each note, and Send / Skip. Nothing goes out without the click; the route
 * (POST /api/portal/events/followups) checks the steward again and re-checks each person. Names only, no emails: a
 * steward needn't be a site admin.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { HELD_TEXT } from "@/lib/nightFollowups";
import type { NightFollowupView } from "@/lib/nightFollowupData";

const VARIANT_LABEL = { guest: "guest note", member: "member note" } as const;

const dayText = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/Denver" });

export function NightFollowups({ nights }: { nights: NightFollowupView[] }) {
  if (nights.length === 0) return null;
  return (
    <section className="space-y-3" data-testid="night-followups">
      <div>
        <h2 className="text-sm font-medium text-muted uppercase tracking-wide">Follow-ups after nights</h2>
        <p className="text-sm text-muted mt-1">
          A short thank-you to the people who RSVP&apos;d, the day after. Nothing goes out until you click Send.
        </p>
      </div>
      {nights.map((n) => (
        // Keyed by state too: after a click, the refreshed night starts fresh (its new buttons, no stale message).
        <Night key={`${n.eventUri}:${n.state}:${n.attempts}:${n.outcomes.map((o) => o.status).join()}`} night={n} />
      ))}
    </section>
  );
}

function Night({ night }: { night: NightFollowupView }) {
  const router = useRouter();
  const [keep, setKeep] = useState<Set<string>>(() => new Set(night.send.map((p) => p.did)));
  const [preview, setPreview] = useState<"guest" | "member" | null>(null);
  const [busy, setBusy] = useState<"send" | "skip" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function decide(decision: "send" | "skip" | "retry") {
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch("/api/portal/events/followups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: night.eventUri, decision, keep: [...keep] }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; sent?: number; failed?: number; held?: number };
      if (!res.ok || !out.ok) throw new Error(out.error ?? "Couldn't tell whether that went through. Reload to see.");
      setDone(
        decision === "skip"
          ? "Skipped."
          : `Sent ${out.sent}${out.failed ? `, ${out.failed} didn't go` : ""}${out.held ? `, ${out.held} held back` : ""}.`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const header = (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <h3 className="font-semibold">{night.name}</h3>
      <span className="text-sm text-muted">{dayText(night.startAt)}</span>
    </div>
  );

  if (night.state !== "open") {
    const sent = night.outcomes.filter((o) => o.status === "sent").length;
    const other = night.outcomes.filter((o) => o.status !== "sent");
    return (
      <Card className="glass-panel" data-testid="followup-night">
        <CardContent className="p-5 space-y-1">
          {header}
          <p className="text-sm text-muted" data-testid="followup-state">
            {night.state === "skipped"
              ? "Skipped."
              : `Sent ${sent} ${sent === 1 ? "note" : "notes"}${night.decidedAt ? ` on ${dayText(night.decidedAt)}` : ""}.`}
            {other.length > 0 &&
              " " +
                other
                  .map((o) => `${o.name}: ${o.status === "held" && o.held ? HELD_TEXT[o.held] : o.status === "failed" ? "didn't go" : "not confirmed"}`)
                  .join("; ") +
                "."}
          </p>
          {night.retryable > 0 &&
            (done ? (
              <p className="text-sm text-sage">{done}</p>
            ) : (
              <div className="pt-2 space-y-2">
                {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
                <Button onClick={() => decide("retry")} disabled={busy !== null} className="btn-glass gap-2 px-5">
                  {busy === "retry" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                  Try the {night.retryable} that didn&apos;t go again
                </Button>
              </div>
            ))}
        </CardContent>
      </Card>
    );
  }

  const chosen = night.send.filter((p) => keep.has(p.did)).length;
  const shown = preview ? night.previews[preview] : undefined;
  return (
    <Card className="glass-panel" data-testid="followup-night">
      <CardContent className="p-5 space-y-4">
        {header}
        {night.rsvpsUnread ? (
          <p className="text-sm text-red-300" role="alert">Couldn&apos;t read this night&apos;s RSVPs from Techne. Reload to try again.</p>
        ) : (
          <>
            {night.send.length === 0 ? (
              <p className="text-sm text-muted">No one to send to.</p>
            ) : (
              <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5" data-testid="followup-people">
                {night.send.map((p) => (
                  <li key={p.did}>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        className="accent-[var(--color-sage,#7fb069)] w-4 h-4"
                        checked={keep.has(p.did)}
                        onChange={(e) =>
                          setKeep((k) => {
                            const next = new Set(k);
                            if (e.target.checked) next.add(p.did);
                            else next.delete(p.did);
                            return next;
                          })
                        }
                      />
                      <span>{p.name}</span>
                      <span className={`text-xs ${p.variant === "member" ? "text-sage" : "text-muted"}`}>{VARIANT_LABEL[p.variant]}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {(night.held.length > 0 || night.noEmail > 0) && (
              <p className="text-xs text-muted" data-testid="followup-held">
                {night.held.length > 0 && <>Left out: {night.held.map((p) => `${p.name} (${p.held ? HELD_TEXT[p.held] : ""})`).join(", ")}. </>}
                {night.noEmail > 0 &&
                  `${night.noEmail} RSVP'd with a Techne account that isn't linked to a member, so there's no email to write to.`}
              </p>
            )}
            {(night.previews.guest || night.previews.member) && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2 text-sm">
                  <span className="text-muted">Preview:</span>
                  {(["guest", "member"] as const).map((v) =>
                    night.previews[v] ? (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setPreview(preview === v ? null : v)}
                        className={`underline-offset-2 hover:underline ${preview === v ? "text-foreground underline" : "text-sage"}`}
                        aria-pressed={preview === v}
                      >
                        {VARIANT_LABEL[v]}
                      </button>
                    ) : null,
                  )}
                </div>
                {shown && (
                  <div className="rounded border border-white/10 overflow-hidden" data-testid="followup-preview">
                    <p className="text-xs text-muted px-3 py-2 bg-white/5">
                      To {shown.name} · <span className="text-foreground">{shown.subject}</span>
                    </p>
                    <iframe title={`${VARIANT_LABEL[preview!]} preview`} srcDoc={shown.html} sandbox="" className="w-full h-[420px] bg-white" />
                  </div>
                )}
              </div>
            )}
            {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
            {done ? (
              <p className="text-sm text-sage">{done}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => decide("send")} disabled={busy !== null || chosen === 0} className="btn-primary-glass gap-2 px-5">
                  {busy === "send" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                  Send {chosen} {chosen === 1 ? "note" : "notes"}
                </Button>
                <Button onClick={() => decide("skip")} disabled={busy !== null} className="btn-glass px-5">
                  {busy === "skip" ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Skip this night
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
