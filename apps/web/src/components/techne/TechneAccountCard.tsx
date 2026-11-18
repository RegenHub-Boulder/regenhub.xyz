"use client";

/**
 * The Techne account linked to a membership, with Unlink (review of PR #122, M1). On /portal/profile for the member
 * (POST /api/portal/techne/unlink) and on the admin member page (POST /api/admin/members/[id]/techne-unlink).
 * Unlinking also ends that account's sign-ins here and the member's other portal sessions (lib/techne/unlink.ts).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function TechneAccountCard({
  did,
  handle,
  endpoint,
  who,
}: {
  did: string | null;
  handle: string | null;
  endpoint: string;
  /** "you" on the profile, the member's name for an admin. */
  who: "you" | string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlink() {
    const whose = who === "you" ? "your" : `${who}'s`;
    if (!window.confirm(`Unlink this Techne account from ${whose} membership? Signing in with it won't open the portal any more.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(out.error ?? "Couldn't unlink just now.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't unlink just now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass-panel p-6 space-y-2" data-testid="techne-account">
      <h2 className="font-semibold flex items-center gap-2">
        <Link2 className="w-4 h-4 text-sage" /> Techne account
      </h2>
      {did ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            <span className="text-forest font-medium">{handle ? `@${handle}` : did}</span>
            <span className="block text-xs text-muted">
              {who === "you" ? "Sign in with Techne with this account opens your portal." : "Signing in with Techne with this account opens their portal."}
            </span>
          </p>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void unlink()} className="btn-glass">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Unlink"}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted">None linked.</p>
      )}
      {error && (
        <p className="text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
