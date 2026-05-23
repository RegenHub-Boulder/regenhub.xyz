"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface Props {
  planKey: string;
  /** When the user is already signed in we don't need to collect email/name */
  isAuthenticated: boolean;
  /** Email of the signed-in user, for display */
  authedEmail?: string;
  cta?: string;
  className?: string;
}

export function SubscribeButton({ planKey, isAuthenticated, authedEmail, cta = "Subscribe", className }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function subscribe(emailToUse?: string, nameToUse?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/membership/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_key: planKey,
          ...(emailToUse ? { email: emailToUse } : {}),
          ...(nameToUse ? { name: nameToUse } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) {
        setError(data?.error ?? "Could not start checkout");
        setBusy(false);
        return;
      }
      window.location.href = data.url as string;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  function onClick() {
    if (isAuthenticated) {
      subscribe();
    } else {
      setShowForm(true);
    }
  }

  if (showForm && !isAuthenticated) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!email.trim() || !name.trim()) {
            setError("Name and email required");
            return;
          }
          subscribe(email.trim(), name.trim());
        }}
        className="space-y-2"
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          required
          className="w-full glass-input rounded-md px-3 py-2 text-sm"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          className="w-full glass-input rounded-md px-3 py-2 text-sm"
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy} className={className ?? "btn-primary-glass flex-1"}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Continue to checkout →"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => { setShowForm(false); setError(null); }}
            className="text-muted text-sm"
          >
            Cancel
          </Button>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <p className="text-xs text-muted">
          We&apos;ll email you a sign-in link after payment so you can manage your subscription.
        </p>
      </form>
    );
  }

  return (
    <div>
      <Button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={className ?? "btn-primary-glass w-full"}
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : cta}
      </Button>
      {isAuthenticated && authedEmail && (
        <p className="text-xs text-muted mt-1.5">Subscribing as {authedEmail}</p>
      )}
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
