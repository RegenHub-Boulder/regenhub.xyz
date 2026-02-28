"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Plus } from "lucide-react";

interface Props {
  memberId: number;
  isFullMember: boolean;
  remainingUses: number;
}

export function RequestDayPassButton({ isFullMember, remainingUses }: Props) {
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState("");
  const [showLabel, setShowLabel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ code: string; expires_at: string } | null>(null);
  const router = useRouter();

  async function handleRequest() {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/portal/request-daypass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setResult(json);
      setLabel("");
      setShowLabel(false);
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
          Expires {new Date(result.expires_at).toLocaleString("en-US", {
            timeZone: "America/Denver",
            month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit", hour12: true,
          })}
        </p>
        <Button
          variant="ghost"
          className="btn-glass mt-3 text-xs"
          onClick={() => setResult(null)}
        >
          Generate another
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {showLabel && (
        <Input
          placeholder={isFullMember ? "Guest name (optional)" : "Label (optional)"}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-48 glass-input text-sm"
          onKeyDown={(e) => e.key === "Enter" && handleRequest()}
        />
      )}
      <div className="flex gap-2">
        {!showLabel && (
          <Button
            variant="ghost"
            size="sm"
            className="btn-glass text-xs"
            onClick={() => setShowLabel(true)}
          >
            Add label
          </Button>
        )}
        <Button
          onClick={handleRequest}
          disabled={loading || remainingUses <= 0}
          className="btn-primary-glass gap-2"
          title={remainingUses <= 0 ? "No uses remaining" : undefined}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {loading ? "Generating…" : isFullMember ? "Generate code" : "Get today's code"}
        </Button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
