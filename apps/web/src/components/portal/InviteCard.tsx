"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { UserPlus, Copy, Check, Loader2 } from "lucide-react";

export default function InviteCard() {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/portal/invite")
      .then((res) => res.json())
      .then((data) => {
        if (data.invite_url) {
          setInviteUrl(data.invite_url);
        } else {
          setError(data.error ?? "Failed to load invite link");
        }
      })
      .catch(() => setError("Failed to load invite link"))
      .finally(() => setLoading(false));
  }, []);

  async function handleCopy() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const el = document.createElement("textarea");
      el.value = inviteUrl;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  if (error) return null; // Silently hide if there's an error

  return (
    <Card className="glass-panel">
      <CardContent className="p-6">
        <UserPlus className="w-8 h-8 text-sage mb-3" />
        <h3 className="font-semibold mb-1">Invite a Friend</h3>
        <p className="text-sm text-muted mb-4">
          Share your personal link to give someone a free day at RegenHub
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading your link…
          </div>
        ) : inviteUrl ? (
          <div className="space-y-3">
            <div className="glass-panel-subtle p-3 rounded-lg">
              <p className="text-xs font-mono text-foreground break-all">
                {inviteUrl}
              </p>
            </div>
            <Button
              onClick={handleCopy}
              variant="ghost"
              className="btn-glass gap-2 w-full"
            >
              {copied ? (
                <Check className="w-4 h-4 text-sage" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
              {copied ? "Copied!" : "Copy Link"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
