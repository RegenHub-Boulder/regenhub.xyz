/**
 * The prices, in cents: the one place they are typed. The web app's plan catalog (apps/web/src/lib/plans.ts) reads
 * them, and so do the emails both apps send (./freeDayEmails.ts), so the bot can't drift from the site.
 * Pure data, safe in a browser bundle (the web imports this file as "@regenhub/shared/prices").
 */

export const DAY_PASS_PUBLIC_CENTS = 3000;
export const DAY_PASS_MEMBER_CENTS = 2500;

/** Each plan's list price a month. */
export const PLAN_MONTHLY_CENTS = {
  member_basic: 3000,
  member_2day: 5000,
  member_5day: 10000,
  hot_desk: 25000,
  cold_desk: 50000,
} as const;

/** An unused free day lapses this many days after it was approved (lapseFreeDays, migration 070's approved_at); the
 *  person can then ask again. One constant: change it here. */
export const FREE_DAY_LAPSE_DAYS = 90;

/** "$30", or "$12.50" when there are cents. */
export function dollars(cents: number): string {
  const d = cents / 100;
  return `$${Number.isInteger(d) ? d.toLocaleString("en-US") : d.toFixed(2)}`;
}
