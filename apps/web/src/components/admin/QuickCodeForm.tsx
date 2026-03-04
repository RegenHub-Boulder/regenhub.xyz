"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Zap, X } from "lucide-react";

const EXPIRY_PRESETS = [
  { label: "4 hrs", hours: 4 },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "1 week", hours: 168 },
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
  const [expiryHours, setExpiryHours] = useState(24);
  const [memberId, setMemberId] = useState<number | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ code: string; expires_at: string; pin_slot: number } | null>(null);
  const router = useRouter();

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
          expires_in_hours: expiryHours,
          member_id: memberId !== "" ? memberId : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setResult(json);
      setLabel("");
      setMemberId("");
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
              Slot {result.pin_slot} · Expires{" "}
              {new Date(result.expires_at).toLocaleString("en-US", {
                timeZone: "America/Denver",
                weekday: "short", month: "short", day: "numeric",
                hour: "numeric", minute: "2-digit", hour12: true,
              })}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="btn-glass text-xs"
            onClick={() => setResult(null)}
          >
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
          <div className="flex gap-1">
            {EXPIRY_PRESETS.map((p) => (
              <button
                key={p.hours}
                type="button"
                onClick={() => setExpiryHours(p.hours)}
                className={`flex-1 px-2 py-2 rounded text-xs transition-colors ${
                  expiryHours === p.hours
                    ? "bg-gold/20 text-gold border border-gold/40"
                    : "bg-white/5 text-muted border border-white/10 hover:bg-white/10"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={loading}
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
