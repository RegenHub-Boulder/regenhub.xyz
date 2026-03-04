"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Zap, X, Infinity } from "lucide-react";

type ExpiryOption = { label: string; hours: number | null };

const EXPIRY_PRESETS: ExpiryOption[] = [
  { label: "4 hrs", hours: 4 },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "1 week", hours: 168 },
  { label: "No expiry", hours: null },
  { label: "Custom", hours: -1 },
];

interface Member {
  id: number;
  name: string;
}

interface Props {
  members: Member[];
}

export function QuickCodeForm({ members }: Props) {
  const [label, setLabel] = useState("");
  const [expiryHours, setExpiryHours] = useState<number | null>(24);
  const [customHours, setCustomHours] = useState("");
  const [memberId, setMemberId] = useState<number | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ code: string; expires_at: string | null; pin_slot: number } | null>(null);
  const router = useRouter();

  const isCustom = expiryHours === -1;
  const effectiveHours = isCustom ? (Number(customHours) || null) : expiryHours;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/admin/quickcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: label || undefined,
          expires_in_hours: effectiveHours,
          member_id: memberId !== "" ? memberId : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setResult(json);
      setLabel("");
      setMemberId("");
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
      <div className="glass-panel p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs text-muted mb-1">Code ready — share with guest</p>
            <p className="text-5xl font-mono font-bold text-gold tracking-widest">{result.code}</p>
            <p className="text-sm text-muted mt-2">
              Slot {result.pin_slot} ·{" "}
              {result.expires_at
                ? <>Expires {new Date(result.expires_at).toLocaleString("en-US", {
                    timeZone: "America/Denver",
                    weekday: "short", month: "short", day: "numeric",
                    hour: "numeric", minute: "2-digit", hour12: true,
                  })}</>
                : "No expiry — revoke manually"}
            </p>
          </div>
          <Button variant="ghost" size="sm" className="btn-glass text-xs" onClick={() => setResult(null)}>
            <Zap className="w-3.5 h-3.5 mr-1.5" />
            Another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="glass-panel p-6">
      <h2 className="font-semibold mb-4 flex items-center gap-2">
        <Zap className="w-4 h-4 text-gold" />
        Quick Code
      </h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Input
            placeholder="Label (e.g. guest name)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="glass-input"
          />
          <select
            value={memberId}
            onChange={(e) => setMemberId(e.target.value === "" ? "" : Number(e.target.value))}
            className="glass-input rounded-md px-3 py-2 text-sm bg-white/5 border border-white/10 text-foreground"
          >
            <option value="">No member (anonymous)</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <div className="flex flex-wrap gap-1">
            {EXPIRY_PRESETS.map((p) => {
              const selected = expiryHours === p.hours;
              return (
                <button
                  key={String(p.hours)}
                  type="button"
                  onClick={() => setExpiryHours(p.hours)}
                  className={`px-2 py-1.5 rounded text-xs transition-colors ${
                    selected
                      ? "bg-gold/20 text-gold border border-gold/40"
                      : "bg-white/5 text-muted border border-white/10 hover:bg-white/10"
                  }`}
                >
                  {p.hours === null ? <Infinity className="w-3.5 h-3.5 inline" /> : p.label}
                </button>
              );
            })}
          </div>
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
              className="glass-input w-40"
              autoFocus
            />
            <span className="text-sm text-muted">hours</span>
          </div>
        )}
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={loading || (isCustom && !customHours)}
            className="btn-primary-glass gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {loading ? "Generating…" : "Generate code"}
          </Button>
          {error && (
            <p className="text-sm text-red-400 flex items-center gap-1">
              <X className="w-3.5 h-3.5" /> {error}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
