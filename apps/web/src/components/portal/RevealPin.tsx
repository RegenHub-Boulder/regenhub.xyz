"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RevealPin({ code, slot }: { code: string; slot: number | null }) {
  const [visible, setVisible] = useState(false);
  const masked = code.replace(/./g, "•");

  return (
    <div>
      <div className="flex items-center gap-3">
        <p className="text-5xl font-mono font-bold text-gold tracking-widest mt-3">
          {visible ? code : masked}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setVisible((v) => !v)}
          className="mt-3 text-muted hover:text-foreground"
          aria-label={visible ? "Hide PIN" : "Reveal PIN"}
        >
          {visible ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
        </Button>
      </div>
      {slot && (
        <p className="text-xs text-muted mt-3">Slot {slot}</p>
      )}
    </div>
  );
}
