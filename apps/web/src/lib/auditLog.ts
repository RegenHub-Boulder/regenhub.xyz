import { createServiceClient } from "@/lib/supabase/admin";

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Standardized actions. Free-text, but using a constant per action keeps the
 * usage consistent across the codebase and makes it easy to filter / count.
 *
 * Naming convention: past-tense verb describing what HAPPENED to the target.
 */
export const AuditAction = {
  // Member-state changes
  MEMBERSHIP_APPROVED:    "membership_approved",
  MEMBERSHIP_REVOKED:     "membership_revoked",
  FULL_ACCESS_APPROVED:   "full_access_approved",
  FULL_ACCESS_REVOKED:    "full_access_revoked",
  MEMBER_DISABLED:        "member_disabled",
  MEMBER_DELETED:         "member_deleted",
  // Balance/credit changes
  PASSES_GRANTED:         "passes_granted",
  PASSES_ADJUSTED:        "passes_adjusted",
  CREDIT_APPLIED:         "credit_applied",
  // Lock / access
  CODE_REVOKED:           "code_revoked",
  LOCK_SYNCED:            "lock_synced",
  // Stripe
  CHECKOUT_LINK_GENERATED: "checkout_link_generated",
  SUBSCRIPTION_CANCELED_BY_ADMIN: "subscription_canceled_by_admin",
  // Comms
  EMAIL_SENT:             "email_sent",
  BATCH_EMAIL_SENT:       "batch_email_sent",
  // Free-day
  FREE_DAY_APPROVED:      "free_day_approved",
  FREE_DAY_REJECTED:      "free_day_rejected",
  // Application
  APPLICATION_APPROVED:   "application_approved",
  APPLICATION_REJECTED:   "application_rejected",
  // Coupon
  COUPON_CREATED:         "coupon_created",
  COUPON_DEACTIVATED:     "coupon_deactivated",
  COUPON_DELETED:         "coupon_deleted",
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

interface LogActionInput {
  /** What happened — use one of the AuditAction constants when possible. */
  action: AuditAction | string;
  /** Who did it. null = system / cron. Pass the admin's `members.id`. */
  actorMemberId?: number | null;
  /** What was touched (table + row id). Use snake_case table names. */
  target?: { table: string; id: string | number };
  /** Idempotency key — passing the same key twice returns ok=false the
   *  second time, with reason="already_recorded". Use for batch operations. */
  idempotencyKey?: string;
  /** Free-form context. Keep small — this is for audit, not data storage. */
  payload?: Record<string, unknown>;
}

interface LogActionResult {
  ok: boolean;
  /** If ok=false, why. Currently "already_recorded" or an error message. */
  reason?: string;
}

/**
 * Write a row to admin_actions. Fire-and-forget by default — callers don't
 * need to await unless they care about the idempotency result. Errors are
 * logged but don't throw, because audit-log failure must not block the
 * actual admin action it's auditing.
 *
 * The optional `admin` arg lets a caller reuse a service client they already
 * have rather than creating a new one — usually the admin client is already
 * being used in the calling route.
 */
export async function logAction(
  input: LogActionInput,
  admin?: ServiceClient,
): Promise<LogActionResult> {
  const client = admin ?? createServiceClient();
  try {
    const { error } = await client.from("admin_actions").insert({
      actor_member_id: input.actorMemberId ?? null,
      action: input.action,
      target_table: input.target?.table ?? null,
      target_id: input.target?.id != null ? String(input.target.id) : null,
      idempotency_key: input.idempotencyKey ?? null,
      payload: input.payload ?? {},
    });
    if (error) {
      // 23505 = unique violation → idempotency hit, this is by design.
      if ((error as { code?: string }).code === "23505") {
        return { ok: false, reason: "already_recorded" };
      }
      console.error("[auditLog] insert error:", error);
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  } catch (err) {
    console.error("[auditLog] unexpected error:", err);
    return { ok: false, reason: err instanceof Error ? err.message : "unknown" };
  }
}

/**
 * Find the actor member-id from a Supabase auth user id. Convenience for
 * routes that need to look it up before calling logAction.
 */
export async function actorIdFromAuthUid(
  authUid: string,
  admin: ServiceClient,
): Promise<number | null> {
  const { data } = await admin
    .from("members")
    .select("id")
    .eq("supabase_user_id", authUid)
    .maybeSingle();
  return data?.id ?? null;
}
