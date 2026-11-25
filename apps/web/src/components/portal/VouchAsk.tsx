"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { usePreview, PREVIEW_TITLE } from "@/components/portal/PreviewContext";
import type { VouchAsk as Ask } from "@/lib/portalHome";

/**
 * Someone applying named this member as someone who knows them (T-482 round 5). One tap vouches: the same function
 * as the chat card's "I know them". If they don't know them, nothing to do: another member can vouch. On the site a
 * co-op member vouches (`here`, migration 074); anyone else is pointed at the card in the members' chat.
 */
export function VouchAsk({ asks, here }: { asks: Ask[]; here: boolean }) {
  const preview = usePreview();
  const [done, setDone] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  return (
    <section className="glass-panel p-5 space-y-3" data-testid="vouch-ask">
      <h3 className="font-semibold">{asks.length === 1 ? "Someone says you know them" : "People say you know them"}</h3>
      <ul className="space-y-3">
        {asks.map((a) => (
          <li key={a.id} className="flex flex-col sm:flex-row sm:items-center gap-2">
            <span className="flex-1 text-sm">
              <strong>{a.name}</strong> applied to join and named you.{a.about ? <span className="text-muted"> Works on: {a.about}</span> : null}
            </span>
            {!here ? (
              <span className="text-sm text-muted">Know them? Tap <strong>I know them</strong> on their card in the members&apos; chat.</span>
            ) : done[a.id] ? (
              <span className="text-sm text-ok">{done[a.id]}</span>
            ) : (
              <Button size="sm" className="btn-primary-glass" disabled={busy !== null || preview} title={preview ? PREVIEW_TITLE : undefined}
                onClick={async () => {
                  setBusy(a.id);
                  const res = await fetch(`/api/portal/applications/${a.id}/vouch`, { method: "POST", headers: { "Content-Type": "application/json" } }).catch(() => null);
                  const json = res ? await res.json().catch(() => ({})) : {};
                  setDone((d) => ({ ...d, [a.id]: res?.ok ? "Thanks: one approval next." : json.error ?? "Couldn't vouch. Try again." }));
                  setBusy(null);
                }}>
                I know them
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">Don&apos;t know them? Leave it: another member can vouch.</p>
    </section>
  );
}
