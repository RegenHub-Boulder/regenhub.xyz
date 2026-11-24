"use client";

import { useState } from "react";
import { PLANS, formatCents } from "@/lib/plans";
import { SubscribeButton } from "@/components/membership/SubscribeButton";
import { CryptoSubscribeButton } from "@/components/membership/CryptoSubscribeButton";
import { usePreview, PREVIEW_TITLE } from "@/components/portal/PreviewContext";

const DAY_PLAN_KEYS = ["member_basic", "member_2day", "member_5day"] as const;
const DESK_KEYS = ["hot_desk", "cold_desk"] as const;

/**
 * The plan picker an approved member sees (T-482 round 5): pick one of the plans, then pay by card or USDC. The day
 * plans for every approved member; the desks (`desks`) only with desk access. Prices from lib/plans.ts only.
 */
export function DayPlanPicker({ email, desks = false }: { email?: string; desks?: boolean }) {
  const preview = usePreview();
  const keys: readonly (typeof DAY_PLAN_KEYS[number] | typeof DESK_KEYS[number])[] = desks ? DESK_KEYS : DAY_PLAN_KEYS;
  const [picked, setPicked] = useState<string>(keys[0]);
  const name = desks ? "desk-plan" : "day-plan";
  return (
    <div className="space-y-4" data-testid={desks ? "desk-plan-picker" : "day-plan-picker"}>
      <fieldset className="border-b border-rule">
        <legend className="sr-only">{desks ? "Pick a desk" : "Pick a day plan"}</legend>
        {keys.map((key) => {
          const p = PLANS[key];
          const what = "monthlyDayPasses" in p && p.monthlyDayPasses
            ? `${p.monthlyDayPasses} day${p.monthlyDayPasses === 1 ? "" : "s"} a month`
            : p.label;
          return (
            <label key={key} className="border-t border-rule py-3 flex items-baseline gap-3 cursor-pointer">
              <input type="radio" name={name} value={key} checked={picked === key} onChange={() => setPicked(key)} className="accent-[var(--sage)]" />
              <span className="w-28 shrink-0">
                <span className="text-gold font-semibold">{formatCents(p.defaultMonthlyCents)}</span>
                <span className="text-muted"> a month</span>
              </span>
              <span>{what}</span>
            </label>
          );
        })}
      </fieldset>
      {preview ? (
        <p className="text-xs text-muted" title={PREVIEW_TITLE}>Pay by card or USDC (off in a preview).</p>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3 items-start" key={picked}>
          <SubscribeButton planKey={picked} isAuthenticated authedEmail={email} cta="Pay by card" className="btn-primary-glass w-full" />
          <CryptoSubscribeButton planKey={picked} className="btn-glass w-full" />
        </div>
      )}
    </div>
  );
}
