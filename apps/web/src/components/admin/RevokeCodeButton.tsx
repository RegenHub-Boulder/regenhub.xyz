"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export function RevokeCodeButton({ codeId, code }: { codeId: number; code: string }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const revoke = async () => {
    if (!confirm(`Revoke code ${code}?`)) return;
    setLoading(true);

    const res = await fetch(`/api/lock/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codeId }),
    });

    if (res.ok) {
      router.refresh();
    } else {
      alert("Failed to revoke code. Try again.");
    }
    setLoading(false);
  };

  return (
    <Button onClick={revoke} disabled={loading} variant="ghost" size="sm" className="btn-glass text-red-400 hover:text-red-300">
      {loading ? "…" : "Revoke"}
    </Button>
  );
}
