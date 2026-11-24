"use client";

import { PLANS, formatCents } from "@/lib/plans";
import { SubscribeButton } from "@/components/membership/SubscribeButton";
import { CryptoSubscribeButton } from "@/components/membership/CryptoSubscribeButton";
import { usePreview, PREVIEW_TITLE } from "@/components/portal/PreviewContext";

const DAY_PLAN_KEYS = ["member_basic", "member_2day", "member_5day"] as const;

/**
 * The plan picker an approved member sees on /portal (T-482 round 5): the three day plans, each by card or USDC.
 * Prices from lib/plans.ts only. Desks aren't here: they're an upgrade a member asks about (DeskAsk).
 */
export function DayPlanPicker({ email, desks = false }: { email?: string; desks?: boolean }) {
  const preview = usePreview();
  const keys = desks ? (["hot_desk", "cold_desk"] as const) : DAY_PLAN_KEYS;
  return (
    <ul className="border-b border-rule" data-testid={desks ? "desk-plan-picker" : "day-plan-picker"}>
      {keys.map((key) => {
        const p = PLANS[key];
        const what = "monthlyDayPasses" in p && p.monthlyDayPasses
          ? `${p.monthlyDayPasses} day${p.monthlyDayPasses === 1 ? "" : "s"} a month`
          : p.label;
        return (
          <li key={key} className="border-t border-rule py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
            <span className="sm:w-56">
              <span className="text-gold font-semibold">{formatCents(p.defaultMonthlyCents)}</span>
              <span className="text-muted"> a month · </span>
              <span>{what}</span>
            </span>
            {preview ? (
              <span className="text-xs text-muted" title={PREVIEW_TITLE}>Card · USDC (off in a preview)</span>
            ) : (
              <span className="flex flex-wrap gap-2 sm:ml-auto">
                <SubscribeButton planKey={key} isAuthenticated authedEmail={email} cta="Pay by card" className="btn-primary-glass text-sm" />
                <CryptoSubscribeButton planKey={key} className="btn-glass text-sm" />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
