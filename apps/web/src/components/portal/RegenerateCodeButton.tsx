"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Loader2, Check } from "lucide-react";

interface Props {
  memberId: number;
  hasSlot: boolean;
}

export function RegenerateCodeButton({ hasSlot }: Props) {
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [customCode, setCustomCode] = useState("");
  const router = useRouter();

  function handleClick() {
    const trimmed = customCode.trim();

    if (trimmed && !/^\d{4,8}$/.test(trimmed)) {
      setError("Code must be 4-8 digits");
      return;
    }

    setConfirming(true);
    setError(null);
  }

  async function handleConfirm() {
    const trimmed = customCode.trim();
    setLoading(true);
    setError(null);
    setWarning(null);

    try {
      const res = await fetch("/api/portal/regenerate-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trimmed ? { code: trimmed } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setCustomCode("");
      setConfirming(false);
      if (json.lock_warning) setWarning(json.lock_warning);
      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        router.refresh();
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setConfirming(false);
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
        {confirming ? (
          <div className="flex items-center gap-1.5">
            <Button
              onClick={handleConfirm}
              disabled={loading}
              className="btn-glass gap-1 text-red-400 border-red-500/20"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {loading ? "Updating..." : "Confirm"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirming(false)}
              disabled={loading}
              className="text-muted"
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            onClick={handleClick}
            disabled={loading || !hasSlot}
            className="btn-glass gap-2"
          >
            {success ? (
              <Check className="w-4 h-4 text-sage" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {success ? "Updated!" : customCode.trim() ? "Set code" : "New code"}
          </Button>
        )}
      </div>

      {confirming && !loading && (
        <p className="text-xs text-amber-400">
          Your old code will stop working immediately.
        </p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {warning && <p className="text-xs text-amber-400">{warning}</p>}
      {!hasSlot && <p className="text-xs text-muted">No slot assigned — contact an admin</p>}
      {hasSlot && !loading && !confirming && !success && (
        <p className="text-xs text-muted">Leave blank to auto-generate</p>
      )}
    </div>
  );
}
