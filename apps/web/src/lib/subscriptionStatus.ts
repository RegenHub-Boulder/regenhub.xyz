/** Subscription statuses that still bill or can still become access. Client-safe. */
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "incomplete"] as const;

export function isLiveSubscription(status: string): boolean {
  return (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}
