"use client";

import { useState, useCallback } from "react";
import { Eye, EyeOff, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RevealPin({ code, slot }: { code: string; slot: number | null }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const masked = code.replace(/./g, "\u2022");

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const el = document.createElement("textarea");
      el.value = code;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [code]);

  return (
    <div>
      <div className="flex items-center gap-3">
        <p className="text-5xl font-mono font-bold text-gold tracking-widest mt-3">
          {visible ? code : masked}
        </p>
        <div className="flex gap-1 mt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVisible((v) => !v)}
            className="text-muted hover:text-foreground"
            aria-label={visible ? "Hide PIN" : "Reveal PIN"}
          >
            {visible ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="text-muted hover:text-foreground"
            aria-label="Copy PIN"
          >
            {copied ? (
              <Check className="w-5 h-5 text-sage" />
            ) : (
              <Copy className="w-5 h-5" />
            )}
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-2">
        {slot && <p className="text-xs text-muted">Slot {slot}</p>}
        {copied && <p className="text-xs text-sage">Copied!</p>}
      </div>
    </div>
  );
}
