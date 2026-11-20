"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Asked once, on /portal, of a member who could be listed and hasn't answered (`show_in_directory` is null): where
 * joining lands (checkout's success URL is /portal?welcome=1). Either answer is saved and the card goes; the
 * member can change it any time on /portal/profile.
 */
export function DirectoryAsk() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<boolean | null>(null);
  const router = useRouter();

  async function answer(yes: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ show_in_directory: yes }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Couldn't save");
      setSaid(yes);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  if (said === true) {
    return (
      <div className="glass-panel p-5 rounded-xl border border-sage/30" data-testid="directory-ask-done">
        <p className="font-medium">You&apos;re in the member directory.</p>
        <p className="text-sm text-muted mt-1">
          <Link href="/portal/profile" className="text-sage underline">
            Add a line about what you&apos;re working on
          </Link>{" "}
          so people know what to ask you about.
        </p>
      </div>
    );
  }
  if (said === false) return null;

  return (
    <div className="glass-panel p-5 rounded-xl border border-sage/30 flex flex-col sm:flex-row gap-4 sm:items-center" data-testid="directory-ask">
      <UserRound className="w-6 h-6 text-sage shrink-0" />
      <div className="flex-1 space-y-1">
        <p className="font-medium">Show you in the member directory?</p>
        <p className="text-sm text-muted">
          Your name, photo and what you&apos;re working on, on a page of your own at{" "}
          <Link href="/members" className="text-sage underline">regenhub.xyz/members</Link>. Never your email or plan.
          You can change this on your profile.
        </p>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
      <div className="flex gap-2 shrink-0">
        <Button type="button" disabled={busy} onClick={() => answer(true)} className="btn-primary-glass">
          Yes, list me
        </Button>
        <Button type="button" disabled={busy} onClick={() => answer(false)} className="btn-glass">
          Not now
        </Button>
      </div>
    </div>
  );
}
