/**
 * The second door's answer when a free day is used (T-482 round 4), the same words on the site and in the bot.
 * apps/web/src/lib/freeDayClaim.ts re-exports these.
 */
import { DAY_PASS_PUBLIC_CENTS, dollars } from "./prices.js";

/** "Nov 5", in Boulder's time. */
export const shortDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Denver" });

/**
 * `passes`: said on Day passes, the page with the buy button. `elsewhere`: names the page and the price, and links it
 * when given a URL (the bot).
 */
export function freeDayUsedLine(at: string | null | undefined, where: "passes" | "elsewhere", passesUrl?: string): string {
  const head = `You've had your free day${at ? ` (${shortDay(at)})` : ""}.`;
  if (where === "passes") return `${head} Buy a day pass below to come again.`;
  return `${head} To come again, a day pass is ${dollars(DAY_PASS_PUBLIC_CENTS)} on Day passes${passesUrl ? `: ${passesUrl}` : "."}`;
}
