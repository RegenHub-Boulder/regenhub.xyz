"use client";

/** "Already a member?": email a link-this-account link to the member email (POST /api/auth/techne/link). */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LinkMembershipForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/techne/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const out = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
      if (!res.ok) throw new Error(out.error ?? "Couldn't send the link.");
      if (out.status === "linked") window.location.replace("/portal");
      else setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the link.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <p className="text-sm" role="status" data-testid="link-sent">
        If <strong>{email}</strong> is on a membership, a link is on its way. Open it in this browser to finish.
      </p>
    );
  }
  return (
    <form onSubmit={send} className="space-y-3">
      <p className="text-sm text-muted">Enter the email on your membership. We&apos;ll email a link to confirm it&apos;s you, once.</p>
      <Input
        type="email"
        required
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        aria-label="Membership email"
      />
      <Button type="submit" disabled={busy || !email} className="btn-glass w-full">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Email me a link"}
      </Button>
      {error && (
        <p className="text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
