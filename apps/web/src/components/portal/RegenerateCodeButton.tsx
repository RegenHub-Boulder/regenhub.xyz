"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { RefreshCw, Loader2 } from "lucide-react";

interface Props {
  memberId: number;
  hasSlot: boolean;
}

export function RegenerateCodeButton({ hasSlot }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleClick() {
    if (!confirm("Generate a new door code? Your old code will stop working immediately.")) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/portal/regenerate-code", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        onClick={handleClick}
        disabled={loading || !hasSlot}
        className="btn-glass gap-2"
        title={!hasSlot ? "No slot assigned — contact an admin" : undefined}
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        {loading ? "Updating lock…" : "New code"}
      </Button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {!hasSlot && <p className="text-xs text-muted">No slot assigned</p>}
    </div>
  );
}
