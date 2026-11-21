import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * One calm badge (T-482 book): a hairline outline and muted ink, words in sentence case. Meaning is carried by the
 * word, never by colour alone. The one exception is "needs you" (a caller passing a warn or danger tone, or the
 * destructive variant): its word is set in ochre, still on the same outline.
 *
 * Callers written for the old palette pass tone classes (bg-ok/10 text-ok border-ok/40 …); they are dropped here so
 * every badge on the site keeps the one skin. Size and spacing classes still apply.
 */
const TONE = /^(?:hover:)?(?:bg|text|border)-(?:ok|warn|danger|note|gold|sage|forest|muted|rule|tint|ink|foreground|transparent)(?:\/[\d.]+)?$/

/** Enum values and lowercase labels, as plain words: "past_due" → "Past due", "no code" → "No code". Anything a
 * caller already capitalised is left as written (proper nouns: "Card · Stripe"). */
const WORDS: Record<string, string> = { trialing: "Trial", past_due: "Past due", uncollectible: "Uncollectible" }
export function plainWords(s: string): string {
  if (WORDS[s]) return WORDS[s]
  if (/^[a-z]/.test(s)) {
    const w = s.replace(/_/g, " ")
    return w.charAt(0).toUpperCase() + w.slice(1)
  }
  return s
}

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "secondary" | "destructive" | "outline" | null
}

function Badge({ className = "", variant, children, ...props }: BadgeProps) {
  const needsYou = variant === "destructive" || /\btext-(?:warn|danger)\b/.test(className)
  const rest = className.split(/\s+/).filter((c) => c && !TONE.test(c) && c !== "capitalize").join(" ")
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-rule bg-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        needsYou ? "text-warn" : "text-muted",
        rest,
      )}
      {...props}
    >
      {typeof children === "string" ? plainWords(children) : children}
    </div>
  )
}

export { Badge }
