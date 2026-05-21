/**
 * Boot-time env validation.
 *
 * Imported from the root layout so missing vars surface at app start
 * instead of as a runtime error on the first request that uses them.
 *
 * "Required" means: the app cannot serve its core flows without it.
 * "Optional but warn" means: some surfaces degrade or break silently.
 *
 * We intentionally don't crash on missing optional vars in production —
 * just log loudly. Some surfaces (Stripe, Telegram) are designed to
 * skip gracefully via isStripeConfigured() etc.
 */

const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const OPTIONAL_BUT_WARN = [
  // Stripe — payments are core. Missing = paid flows return 503.
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  // Public-facing — affects redirect URLs after auth/checkout
  "NEXT_PUBLIC_SITE_URL",
  // Telegram — admin notifications go silent if missing
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_GROUP_CHAT_ID",
  // Cron auth — past-due sweep returns 503 without it
  "CRON_SECRET",
] as const;

let validated = false;

export function validateEnv(): void {
  if (validated) return;
  validated = true;

  const missing: string[] = [];
  const warnings: string[] = [];

  for (const key of REQUIRED) {
    if (!process.env[key]) missing.push(key);
  }
  for (const key of OPTIONAL_BUT_WARN) {
    if (!process.env[key]) warnings.push(key);
  }

  if (missing.length > 0) {
    const msg = `[env] Missing required env vars: ${missing.join(", ")}`;
    // In dev, throw — easier to debug. In prod, log loudly but don't
    // crash the whole server (some pages may still serve).
    if (process.env.NODE_ENV === "development") {
      throw new Error(msg);
    }
    console.error(msg);
  }

  if (warnings.length > 0) {
    console.warn(`[env] Missing optional env vars (some features will degrade): ${warnings.join(", ")}`);
  }
}

// Run on import
validateEnv();
