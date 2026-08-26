"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link2, Loader2, CheckCircle } from "lucide-react";

/**
 * BYOD path: a logged-in member with no `members.did` yet. If this browser
 * already holds a regenOS session, one click writes the DID. Otherwise we
 * point them at /auth/login to pick up a regenOS session, then they come back.
 */
export function LinkRegenOSCard() {
  const [busy, setBusy] = useState(false);
  const [handle, setHandle] = useState<string | null | undefined>(undefined);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [linked, setLinked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/xrpc/social.scenius.getSession", { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setHandle(null);
          return;
        }
        const data = (await res.json()) as { did?: string; handle?: string };
        if (cancelled) return;
        setHandle(data.did ? (data.handle ?? data.did) : null);
      } catch {
        if (!cancelled) setHandle(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function link() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/auth/regenos/link", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        did?: string;
        already?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setErr(json.error ?? `Couldn't link (${res.status})`);
        return;
      }
      setLinked(true);
      setMsg(json.already ? "Already linked." : "Linked this regenOS identity to your membership.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (linked) {
    return (
      <Card className="glass-panel border border-sage/30">
        <CardContent className="p-6 flex items-start gap-4">
          <CheckCircle className="w-7 h-7 text-sage shrink-0 mt-0.5" />
          <div>
            <h3 className="font-semibold mb-1">regenOS identity linked</h3>
            <p className="text-sm text-muted">{msg}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const waiting = handle === undefined;

  return (
    <Card className="glass-panel">
      <CardContent className="p-6 flex items-start gap-4">
        <Link2 className="w-7 h-7 text-sage shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="font-semibold mb-1">Link your regenOS identity</h3>
          <p className="text-sm text-muted mb-3">
            Attach the atproto account you sign in with, even if it has no email.
            After this, that identity opens your membership without a magic link.
          </p>
          {waiting ? (
            <p className="text-xs text-muted">Checking for a regenOS session…</p>
          ) : handle ? (
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                type="button"
                size="sm"
                className="btn-primary-glass"
                onClick={link}
                disabled={busy}
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                Link {handle}
              </Button>
              {err && <p className="text-xs text-red-400">{err}</p>}
            </div>
          ) : (
            <Link href="/auth/login">
              <Button type="button" size="sm" className="btn-glass">
                Sign in with regenOS to link
              </Button>
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
