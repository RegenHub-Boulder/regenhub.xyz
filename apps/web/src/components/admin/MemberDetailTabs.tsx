"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect } from "react";

export type TabKey = "overview" | "billing" | "access";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "billing",  label: "Billing" },
  { key: "access",   label: "Access" },
];

interface Props {
  children: Record<TabKey, React.ReactNode>;
}

export function MemberDetailTabs({ children }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const initial = (params.get("tab") as TabKey) ?? "overview";
  const [active, setActive] = useState<TabKey>(
    TABS.some((t) => t.key === initial) ? initial : "overview",
  );

  // Keep URL in sync so refresh + share preserves the tab
  useEffect(() => {
    const current = params.get("tab");
    if (current !== active) {
      const next = new URLSearchParams(params.toString());
      next.set("tab", active);
      router.replace(`?${next.toString()}`, { scroll: false });
    }
  }, [active, params, router]);

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b border-white/10 -mb-px">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              active === t.key
                ? "border-sage text-sage"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="space-y-6">{children[active]}</div>
    </div>
  );
}
