/**
 * Single source of truth for transactional email defaults.
 *
 * Both `apps/web` and `apps/bot` import these helpers so:
 *   - the From and Reply-To addresses are consistent across all transactional
 *     mail (subscription approvals, payment reminders, admin digest, etc.);
 *   - changing the runtime defaults is a single env-var flip (in BOTH Coolify
 *     apps' env vars, since they're separate deployments) and that's it;
 *   - changing the fallback constants is a single file edit here.
 *
 * Env vars (both apps read the same names):
 *   EMAIL_FROM      — "RegenHub <noreply@mail.unforced.dev>" by default
 *   EMAIL_REPLY_TO  — "ag@unforced.org" by default
 *
 * Migration note: when forwarding from boulder.regenhub@gmail.com →
 * ag@unforced.org is set up, flip the EMAIL_REPLY_TO default back to the
 * brand-aligned address.
 */

const FROM_FALLBACK = "RegenHub <noreply@mail.unforced.dev>";
const REPLY_TO_FALLBACK = "ag@unforced.org";

export function defaultEmailFrom(): string {
  return process.env.EMAIL_FROM ?? FROM_FALLBACK;
}

export function defaultEmailReplyTo(): string {
  return process.env.EMAIL_REPLY_TO ?? REPLY_TO_FALLBACK;
}
