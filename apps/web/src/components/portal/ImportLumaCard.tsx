"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Download } from "lucide-react";
import { buildCreateEventInput, mintRkey } from "@/lib/regenos/eventForm";
import { lumaEventToFormValues, type ParsedLumaEvent } from "@/lib/lumaImport";

async function xrpcPost(nsid: string, body: unknown): Promise<void> {
  const res = await fetch(`/xrpc/${nsid}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(json?.message ?? json?.error ?? `regenOS returned ${res.status}`);
  }
}

export function ImportLumaCard({
  authority,
  onImported,
}: {
  authority: string;
  onImported: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<ParsedLumaEvent[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [done, setDone] = useState<string | null>(null);

  async function preview() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/portal/events/import-luma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const json = (await res.json()) as {
        events?: ParsedLumaEvent[];
        errors?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `Preview failed (${res.status})`);
      const list = json.events ?? [];
      setEvents(list);
      setPicked(new Set(list.map((_, i) => i)));
      if (list.length === 0) {
        setError(json.errors?.join(" · ") || "No Luma events in that paste.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importPicked() {
    setImporting(true);
    setError(null);
    setDone(null);
    let ok = 0;
    const fails: string[] = [];
    try {
      for (const i of [...picked].sort((a, b) => a - b)) {
        const ev = events[i];
        if (!ev) continue;
        try {
          await xrpcPost(
            "social.scenius.createEvent",
            buildCreateEventInput(lumaEventToFormValues(ev), { authority, rkey: mintRkey() }),
          );
          ok += 1;
        } catch (e) {
          fails.push(`${ev.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setDone(`Imported ${ok} of ${picked.size}` + (fails.length ? ` · ${fails.length} failed` : ""));
      if (fails.length) setError(fails.join(" · "));
      if (ok) await onImported();
    } finally {
      setImporting(false);
    }
  }

  return (
    <Card className="glass-panel">
      <CardContent className="p-6 space-y-3">
        <h3 className="font-semibold flex items-center gap-2">
          <Download className="w-4 h-4 text-sage" />
          Import from Luma
        </h3>
        <p className="text-sm text-muted">
          Paste luma.com event URLs or the HTML of a public Luma page. No Pro API.
          Preview first, then write to the collective calendar.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="https://luma.com/regenhub-mp3c or https://lu.ma/…"
          className="glass-input w-full px-3 py-2 rounded text-sm font-mono"
        />
        <div className="flex gap-2 flex-wrap">
          <Button type="button" size="sm" className="btn-glass" onClick={preview} disabled={busy || !text.trim()}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Preview
          </Button>
          {events.length > 0 && (
            <Button
              type="button"
              size="sm"
              className="btn-primary-glass"
              onClick={importPicked}
              disabled={importing || picked.size === 0}
            >
              {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Import {picked.size} selected
            </Button>
          )}
        </div>
        {events.length > 0 && (
          <ul className="text-sm space-y-1">
            {events.map((e, i) => (
              <li key={e.url || `${e.name}-${i}`} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={picked.has(i)}
                  onChange={() => {
                    const next = new Set(picked);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    setPicked(next);
                  }}
                />
                <span>
                  <span className="font-medium">{e.name}</span>
                  {e.startAt && (
                    <span className="text-muted">
                      {" "}
                      · {new Date(e.startAt).toLocaleString("en-US", { timeZone: "America/Denver" })}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {done && <p className="text-xs text-sage">{done}</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </CardContent>
    </Card>
  );
}
