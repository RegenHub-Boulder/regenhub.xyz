"use client";

/**
 * The button on the page the link email opens (/auth/techne/link?code=…). The page links nothing by itself (mail
 * scanners open links): the person, signed in with Techne as the account that asked, presses it. The server checks
 * the code was asked for by this same Techne account (confirm_techne_link).
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function TechneLinkConfirm({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/techne/link/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(out.error ?? "Couldn't link just now.");
      window.location.replace("/portal");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't link just now.");
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" disabled={busy} onClick={() => void link()} className="btn-primary-glass px-6">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Link and open my portal"}
      </Button>
      {error && (
        <p className="text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
