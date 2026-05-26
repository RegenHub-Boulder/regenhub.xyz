"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

interface Props {
  title: React.ReactNode;
  /** Short hint text rendered next to the chevron when collapsed */
  hint?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/** Click-to-expand wrapper. Renders children only when open so heavy
 * server-rendered tables don't slow the page on load. */
export function CollapsibleSection({ title, hint, defaultOpen = false, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="glass-panel">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full px-5 py-4 flex items-center justify-between gap-3 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2 text-left">
          {open ? <ChevronDown className="w-4 h-4 text-muted" /> : <ChevronRight className="w-4 h-4 text-muted" />}
          {title}
        </div>
        {!open && hint && <span className="text-xs text-muted">{hint}</span>}
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  );
}
