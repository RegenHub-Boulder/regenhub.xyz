"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Upload } from "lucide-react";

interface Summary {
  rows: number;
  add: number;
  alreadyHave: number;
  unsubscribedHere: number;
  unsubscribedOnLuma: number;
  notRegistered: number;
  invalid: number;
  duplicate: number;
  imported?: number;
  error?: string;
}

async function post(csv: string, commit: boolean): Promise<Summary> {
  const res = await fetch("/api/admin/newsletter/import-luma", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv, commit }),
  });
  const data = (await res.json().catch(() => null)) as Summary | null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data!;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Newsletter → Audience: add the people in a Luma CSV export (the calendar's people, or an event's guests) to the
 * interests list. Choosing a file shows what an import would do; "Import" does it. No Luma API involved.
 */
export function LumaCsvImport({ disabled }: { disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function choose(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setErr(null);
    setSummary(null);
    setBusy("check");
    try {
      const csv = await f.text();
      setFile({ name: f.name, csv });
      setSummary(await post(csv, false));
    } catch (x) {
      setFile(null);
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!file) return;
    setErr(null);
    setBusy("import");
    try {
      setSummary(await post(file.csv, true));
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(null);
    }
  }

  const skipped = summary
    ? [
        summary.unsubscribedOnLuma && `${summary.unsubscribedOnLuma} unsubscribed on Luma`,
        summary.unsubscribedHere && `${summary.unsubscribedHere} unsubscribed from our newsletter`,
        summary.notRegistered && `${summary.notRegistered} invited or declined`,
        summary.invalid && plural(summary.invalid, "invalid email"),
        summary.duplicate && plural(summary.duplicate, "repeat"),
      ].filter(Boolean)
    : [];
  const done = summary?.imported !== undefined;

  return (
    <div className="space-y-2" data-testid="luma-csv-import">
      <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={choose} aria-label="Luma CSV export" />
      <Button
        size="sm"
        disabled={disabled || !!busy}
        onClick={() => input.current?.click()}
        className="btn-glass text-xs gap-1 h-7"
      >
        {busy === "check" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />} Import Luma CSV…
      </Button>
      {summary && file && (
        <div className="text-xs space-y-2 rounded-md border border-sage/20 p-3" data-testid="luma-csv-summary">
          <p className="text-muted">
            <span className="text-foreground">{file.name}</span>: {plural(summary.rows, "row")}.
          </p>
          <p>
            {done ? (
              <span className="text-sage">Added {plural(summary.imported!, "new contact")} to the interests list.</span>
            ) : (
              <>
                <span className="text-foreground font-medium">{summary.add} new</span>
                <span className="text-muted"> · {summary.alreadyHave} already have</span>
              </>
            )}
            {skipped.length > 0 && <span className="text-muted"> · skipped {skipped.join(", ")}</span>}
          </p>
          {!done && (
            <div className="flex gap-2">
              <Button size="sm" disabled={disabled || !!busy || summary.add === 0} onClick={commit} className="btn-primary-glass text-xs gap-1 h-7">
                {busy === "import" && <Loader2 className="w-3 h-3 animate-spin" />} Import {summary.add}
              </Button>
              <Button size="sm" disabled={!!busy} onClick={() => { setSummary(null); setFile(null); }} className="btn-glass text-xs h-7">
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
      {err && <p className="text-xs text-danger" role="alert">{err}</p>}
    </div>
  );
}
