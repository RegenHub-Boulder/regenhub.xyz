"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Loader2 } from "lucide-react";

interface Props {
  memberId: number;
  hasSlot: boolean;
}

export function RegenerateCodeButton({ hasSlot }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customCode, setCustomCode] = useState("");
  const router = useRouter();

  async function handleClick() {
    const trimmed = customCode.trim();

    if (trimmed && !/^\d{4,8}$/.test(trimmed)) {
      setError("Code must be 4–8 digits");
      return;
    }

    const msg = trimmed
      ? `Set your door code to ${trimmed}? Your old code will stop working immediately.`
      : "Generate a new random door code? Your old code will stop working immediately.";
    if (!confirm(msg)) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/portal/regenerate-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trimmed ? { code: trimmed } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setCustomCode("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <Input
          type="text"
          inputMode="numeric"
          pattern="\d*"
          placeholder="Custom code (optional)"
          value={customCode}
          onChange={(e) => {
            setError(null);
            setCustomCode(e.target.value.replace(/\D/g, "").slice(0, 8));
          }}
          disabled={loading || !hasSlot}
          className="w-44 text-sm font-mono bg-white/5 border-white/10"
          maxLength={8}
        />
        <Button
          onClick={handleClick}
          disabled={loading || !hasSlot}
          className="btn-glass gap-2"
          title={!hasSlot ? "No slot assigned — contact an admin" : undefined}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {loading ? "Updating lock…" : customCode.trim() ? "Set code" : "New code"}
        </Button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {!hasSlot && <p className="text-xs text-muted">No slot assigned</p>}
      {hasSlot && !loading && (
        <p className="text-xs text-muted">Leave blank to auto-generate</p>
      )}
    </div>
  );
}
