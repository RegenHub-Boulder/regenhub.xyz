"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect } from "react";

export interface TabDef<K extends string> {
  key: K;
  label: string;
  /** Optional small badge after the label (e.g. count, pending indicator) */
  badge?: React.ReactNode;
}

interface Props<K extends string> {
  tabs: TabDef<K>[];
  defaultTab?: K;
  /** Map of tab key → content. */
  children: Record<K, React.ReactNode>;
  /** Override the URL search param name (default: `tab`) */
  paramName?: string;
}

/**
 * URL-synced tabs for admin pages. Renders all tab content but only shows
 * the active one — fine for the data volumes we have. Tab state lives in
 * the URL (?tab=foo) so refresh + share preserves the view.
 */
export function AdminTabs<K extends string>({
  tabs,
  defaultTab,
  children,
  paramName = "tab",
}: Props<K>) {
  const router = useRouter();
  const params = useSearchParams();
  const fromUrl = params.get(paramName) as K | null;
  const initial: K =
    fromUrl && tabs.some((t) => t.key === fromUrl)
      ? fromUrl
      : (defaultTab ?? tabs[0].key);
  const [active, setActive] = useState<K>(initial);

  useEffect(() => {
    const current = params.get(paramName);
    if (current !== active) {
      const next = new URLSearchParams(params.toString());
      next.set(paramName, active);
      router.replace(`?${next.toString()}`, { scroll: false });
    }
  }, [active, params, router, paramName]);

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b border-white/10 -mb-px overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap ${
              active === t.key
                ? "border-sage text-sage"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {t.label}
            {t.badge}
          </button>
        ))}
      </div>
      <div className="space-y-6">{children[active]}</div>
    </div>
  );
}
