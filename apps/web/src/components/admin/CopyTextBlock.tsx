"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** A block of plain text with a Copy button above it, for pasting into another document. */
export function CopyTextBlock({ text, label = "Copy as text" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() =>
          navigator.clipboard.writeText(text).then(() => setState("copied"), () => setState("failed"))
        }
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded btn-glass"
      >
        {state === "copied" ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        {state === "copied" ? "Copied" : label}
      </button>
      {state === "failed" && <span className="ml-2 text-xs text-amber-400">This browser blocked copying; select the text below.</span>}
      <pre className="whitespace-pre-wrap text-xs leading-relaxed font-mono bg-black/20 rounded p-3 text-foreground/90">{text}</pre>
    </div>
  );
}
