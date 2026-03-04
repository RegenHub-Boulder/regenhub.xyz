"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, Settings2, Infinity } from "lucide-react";

type ExpiryOption = { label: string; hours: number | null };

const EXPIRY_PRESETS: ExpiryOption[] = [
  { label: "4 hrs", hours: 4 },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "1 week", hours: 168 },
  { label: "No expiry", hours: null },
  { label: "Custom", hours: -1 },
];

interface Props {
  memberId: number;
  isFullMember: boolean;
  remainingUses: number;
}

export function RequestDayPassButton({ isFullMember, remainingUses }: Props) {
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [expiryHours, setExpiryHours] = useState<number | null>(24);
  const [customHours, setCustomHours] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ code: string; expires_at: string | null } | null>(null);
  const router = useRouter();

  const isCustom = expiryHours === -1;
  const effectiveHours = isCustom ? (Number(customHours) || null) : expiryHours;

  async function handleRequest() {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/portal/request-daypass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label || undefined, expires_in_hours: effectiveHours }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setResult(json);
      setLabel("");
      setShowForm(false);
      setCustomHours("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (result) {
    return (
      <div className="text-center">
        <p className="text-sm text-muted mb-1">New code ready</p>
        <p className="text-3xl font-mono font-bold text-gold">{result.code}</p>
        <p className="text-xs text-muted mt-1">
          {result.expires_at
            ? <>Expires {new Date(result.expires_at).toLocaleString("en-US", {
                timeZone: "America/Denver",
                month: "short", day: "numeric",
                hour: "numeric", minute: "2-digit", hour12: true,
              })}</>
            : "No expiry — revoke manually to remove"}
        </p>
        <Button variant="ghost" className="btn-glass mt-3 text-xs" onClick={() => setResult(null)}>
          Generate another
        </Button>
      </div>
    );
  }

  const canGenerate = isFullMember || remainingUses > 0;

  return (
    <div className="flex flex-col items-end gap-2">
      {showForm && (
        <div className="flex flex-col gap-2 items-end">
          <div className="flex gap-1 flex-wrap justify-end">
            {EXPIRY_PRESETS.map((p) => {
              const selected = expiryHours === p.hours;
              return (
                <button
                  key={String(p.hours)}
                  type="button"
                  onClick={() => setExpiryHours(p.hours)}
                  className={`px-3 py-1 rounded text-xs transition-colors ${
                    selected
                      ? "bg-gold/20 text-gold border border-gold/40"
                      : "bg-white/5 text-muted border border-white/10 hover:bg-white/10"
                  }`}
                >
                  {p.hours === null ? <Infinity className="w-3 h-3 inline" /> : p.label}
                </button>
              );
            })}
          </div>
          {isCustom && (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min="1"
                max="8760"
                placeholder="Hours (e.g. 48)"
                value={customHours}
                onChange={(e) => setCustomHours(e.target.value)}
                className="w-36 glass-input text-sm"
                autoFocus
              />
              <span className="text-xs text-muted">hrs</span>
            </div>
          )}
          <Input
            placeholder={isFullMember ? "Guest name (optional)" : "Label (optional)"}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-52 glass-input text-sm"
            onKeyDown={(e) => e.key === "Enter" && !isCustom && handleRequest()}
          />
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="btn-glass gap-1.5 text-xs"
          onClick={() => setShowForm((v) => !v)}
          disabled={!canGenerate}
        >
          <Settings2 className="w-3 h-3" />
          {showForm ? "Hide" : "Options"}
        </Button>
        <Button
          onClick={handleRequest}
          disabled={loading || !canGenerate || (isCustom && !customHours)}
          className="btn-primary-glass gap-2"
          title={!canGenerate ? "No uses remaining" : undefined}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {loading ? "Generating…" : isFullMember ? "Generate code" : "Get door code"}
        </Button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
