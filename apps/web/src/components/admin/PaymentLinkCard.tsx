"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link, Check } from "lucide-react";

interface Props {
  daypassUrl: string | null;
  fivepackUrl: string | null;
  memberName: string;
}

function CopyButton({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-center justify-between gap-3 py-3 border-b border-white/5 last:border-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted font-mono truncate max-w-xs mt-0.5">{url}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={copy}
        className={`btn-glass shrink-0 gap-1.5 text-xs ${copied ? "text-sage" : ""}`}
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Link className="w-3.5 h-3.5" />}
        {copied ? "Copied!" : "Copy"}
      </Button>
    </div>
  );
}

export function PaymentLinkCard({ daypassUrl, fivepackUrl, memberName }: Props) {
  if (!daypassUrl && !fivepackUrl) return null;

  return (
    <Card className="glass-panel">
      <CardContent className="p-6">
        <h3 className="font-semibold mb-1">Share payment link</h3>
        <p className="text-xs text-muted mb-4">
          Pre-filled for {memberName} — send via Telegram or email. Balance tops up automatically on payment.
        </p>
        {daypassUrl && <CopyButton url={daypassUrl} label="Single Day Pass — $25" />}
        {fivepackUrl && <CopyButton url={fivepackUrl} label="5-Pack — $100" />}
      </CardContent>
    </Card>
  );
}
