"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { usePreview, PREVIEW_TITLE } from "@/components/portal/PreviewContext";

/**
 * "Talk to us about a desk" (T-482 round 5): desks are an upgrade for members. The ask posts to the members' chat and
 * shows on the admin home; a steward who approves desks talks with them and turns desk access on.
 */
export function DeskAsk({ askedAt }: { askedAt: string | null }) {
  const preview = usePreview();
  const [asked, setAsked] = useState<string | null>(askedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (asked) {
    const day = new Date(asked).toLocaleDateString("en-US", { timeZone: "America/Denver", month: "short", day: "numeric" });
    return <p className="text-sm text-muted" data-testid="desk-asked">You asked about a desk on {day}. A steward will be in touch within a day.</p>;
  }
  return (
    <div className="space-y-2" data-testid="desk-ask">
      <Button className="btn-glass text-sm" disabled={busy || preview} title={preview ? PREVIEW_TITLE : undefined}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await fetch("/api/portal/desk-ask", { method: "POST", headers: { "Content-Type": "application/json" } }).catch(() => null);
          const json = res ? await res.json().catch(() => ({})) : {};
          if (res?.ok) setAsked(json.asked_at ?? new Date().toISOString());
          else setError(json.error ?? "Couldn't send that. Try again.");
          setBusy(false);
        }}>
        Talk to us about a desk
      </Button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
