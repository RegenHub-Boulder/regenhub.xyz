"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Eye, Newspaper } from "lucide-react";

interface PreviewResult {
  sent_preview_to: string;
  ok: boolean;
  issue_key: string;
  note_included: boolean;
  events_count: number;
  audience_size: number;
}

/**
 * Newsletter status + preview trigger. Sits next to the DigestNoteCard
 * (which feeds the note INTO the newsletter) on /admin/communications.
 */
export function NewsletterCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function preview() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/newsletter-preview", { method: "POST" });
      const raw = await res.text();
      let data: PreviewResult | { error: string } | null = null;
      if (raw) { try { data = JSON.parse(raw); } catch { /* keep null */ } }
      if (!res.ok || !data) {
        setError((data as { error?: string })?.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(data as PreviewResult);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="glass-panel border border-sage/20">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Newspaper className="w-4 h-4 text-sage" />
          <h3 className="text-sm font-semibold">Biweekly newsletter</h3>
        </div>
        <p className="text-xs text-muted">
          Sends automatically every other Tuesday (odd ISO weeks) to all members +
          the interests list: your note above, upcoming Luma events, and the
          last-two-weeks numbers. Preview compiles the real issue and sends it
          only to you.
        </p>
        <Button size="sm" disabled={busy} onClick={preview} className="btn-glass text-xs gap-1 h-7">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
          Send preview to me
        </Button>
        {result && (
          <div className="text-xs text-muted space-y-0.5">
            <p className="text-sage">✓ Preview sent to {result.sent_preview_to}</p>
            <p>Issue {result.issue_key} · {result.events_count} event{result.events_count === 1 ? "" : "s"} · note {result.note_included ? "included" : "not set"} · would reach {result.audience_size} people</p>
          </div>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </CardContent>
    </Card>
  );
}
