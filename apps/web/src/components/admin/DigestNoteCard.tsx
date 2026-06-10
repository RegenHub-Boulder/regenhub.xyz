"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, PenLine, Check } from "lucide-react";

/**
 * Composer for the human note that goes into the next monthly hub-health
 * digest. One note waits at a time; saving replaces the previous unsent one.
 */
export function DigestNoteCard() {
  const [note, setNote] = useState("");
  const [existingAt, setExistingAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/digest-note")
      .then((r) => r.json())
      .then((d) => {
        if (d?.note) {
          setNote(d.note.note);
          setExistingAt(d.note.created_at);
        }
      })
      .catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/admin/digest-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Save failed");
        return;
      }
      setSaved(true);
      setExistingAt(new Date().toISOString());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="glass-panel border border-gold/20">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <PenLine className="w-4 h-4 text-gold" />
          <h3 className="text-sm font-semibold">Newsletter note</h3>
        </div>
        <p className="text-xs text-muted">
          A short human note from you that leads the next newsletter issue
          (biweekly, alongside upcoming events + the numbers). Write it any
          time — the next send picks it up automatically.
        </p>
        <textarea
          value={note}
          onChange={(e) => { setNote(e.target.value); setSaved(false); }}
          rows={5}
          maxLength={2000}
          placeholder="What happened at the hub this month? What's coming? What are you grateful for?"
          className="glass-input w-full text-sm px-3 py-2 rounded"
        />
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={busy || !note.trim()} onClick={save} className="btn-primary-glass text-xs gap-1 h-7">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <Check className="w-3 h-3" /> : <PenLine className="w-3 h-3" />}
            {saved ? "Saved" : "Save for next digest"}
          </Button>
          {existingAt && !saved && (
            <p className="text-[10px] text-muted">
              A note is waiting (last edited {new Date(existingAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}) — saving replaces it.
            </p>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
