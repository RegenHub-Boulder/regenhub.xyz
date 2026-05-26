"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Mail, Loader2, Check } from "lucide-react";

interface Props {
  memberId: number;
}

export function SendPaymentReminderButton({ memberId }: Props) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${memberId}/send-payment-reminder`, {
        method: "POST",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Send failed");
        return;
      }
      setSent(true);
      setTimeout(() => setSent(false), 4000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={busy}
        onClick={send}
        className="btn-glass text-xs h-7 gap-1 shrink-0"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" />
          : sent ? <Check className="w-3 h-3 text-emerald-400" />
          : <Mail className="w-3 h-3" />}
        {sent ? "Sent" : "Send reminder"}
      </Button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
