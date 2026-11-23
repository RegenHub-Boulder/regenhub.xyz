import { createServiceClient } from "@/lib/supabase/admin";
import { PAYING_STATUSES } from "@/lib/memberStanding";
import { isListed } from "@/lib/memberDirectory";
import { startOfDayIn } from "@/lib/series";
import { AuditAction, logAction } from "@/lib/auditLog";
import type { ApplicationStatus } from "@/lib/supabase/types";
import type { ActiveDayCode } from "@/components/portal/DayPassRedemptionHero";

/**
 * Everything the member home (/portal) shows, as plain data: `components/portal/PortalHome.tsx` renders it and reads
 * nothing itself. Three sources fill it:
 *   - `loadPortalHome` for the signed-in member (their own rows),
 *   - `loadMemberPortalHome` for an admin viewing one real member (codes masked, every view audited),
 *   - `lib/portalFixtures.ts` for an admin viewing a kind of member (fictional, no reads at all).
 */

type Db = ReturnType<typeof createServiceClient>;

export interface PortalMember {
  id: number;
  name: string;
  member_type: string;
  pin_code: string | null;
  created_at: string;
  is_coop_member: boolean | null;
  is_admin: boolean | null;
  disabled?: boolean | null;
  day_passes_balance: number | null;
  approved_for_daily: boolean | null;
  profile_photo_url: string | null;
  bio: string | null;
  telegram_username: string | null;
  show_in_directory?: boolean | null;
}

export interface PortalApplication {
  status: ApplicationStatus;
  email: string;
  membership_interest: string;
}

export interface PortalSubscription {
  id: number;
  plan_key: string;
  payment_rail: "stripe" | "onchain";
  wallet_id: number | null;
  monthly_cents: number;
  net_cents: number | null;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  past_due_since: string | null;
  discount_cents: number | null;
  pending_plan_key?: string | null;
  pending_plan_at?: string | null;
  pending_plan_from?: string | null;
}

export interface PortalOnchainInvoice {
  id: number;
  amount_cents: number;
  amount_usdc_micros: number;
  due_at: string;
  status: string;
  submitted_tx_hash: string | null;
  coupon_code?: string | null;
  coupon_discount_cents?: number;
}

export interface PortalHomeView {
  nowMs: number;
  /** The sign-in email (the not-a-member screen shows it); null for a synthetic one. */
  userEmail: string | null;
  member: PortalMember | null;
  application: PortalApplication | null;
  freeDayClaim: { claimed_date: string; status: string } | null;
  interestSignupAt: string | null;
  subscription: PortalSubscription | null;
  askDirectory: boolean;
  onchainWallet: { address: string; verification_method: string } | null;
  onchainInvoice: PortalOnchainInvoice | null;
  idleWallet: { id: number; address: string } | null;
  hereNowCount: number;
  installPromptEligible: boolean;
  /** A day-pass member's code live right now (the hero shows it; it also opens Hub Essentials on a visit day). */
  dayCode: ActiveDayCode | null;
  /** Set only in a preview: the controls render disabled, the client fetches nothing of its own. */
  preview?: boolean;
}

/** What a preview shows in place of any door code: never a real one. */
export const PLACEHOLDER_CODE = "000000";

/**
 * The reads behind the member home, for one member (or none: an applicant, a newcomer). `own` reads the member's own
 * rows (the signed-in user's RLS client, or the service client for an admin's view); `service` reads what RLS hides.
 * Read-only: nothing here writes.
 */
export async function loadPortalHome(
  db: { own: Db; service: Db },
  who: { member: PortalMember | null; application: PortalApplication | null; userId: string | null; userEmail: string | null },
  nowMs: number,
): Promise<PortalHomeView> {
  const { own, service } = db;
  const { member } = who;
  const nowIso = new Date(nowMs).toISOString();

  // Free day claim for a day-pass member (often made from a free day). Service client: not in the typed RLS schema.
  let freeDayClaim: PortalHomeView["freeDayClaim"] = null;
  if (member?.member_type === "day_pass" && who.userId) {
    const { data } = await service
      .from("free_day_claims")
      .select("id, claimed_date, status")
      .eq("supabase_user_id", who.userId)
      .in("status", ["pending", "reserved", "activated"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    freeDayClaim = data ? { claimed_date: data.claimed_date, status: data.status } : null;
  }

  // The original interest signup (if any) for the funnel-continuity line.
  let interestSignupAt: string | null = null;
  if (member) {
    const { data } = await own
      .from("interests")
      .select("created_at")
      .eq("member_id", member.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    interestSignupAt = data?.created_at ?? null;
  }

  let subscription: PortalSubscription | null = null;
  if (member) {
    const { data } = await own
      .from("subscriptions")
      .select("id, payment_rail, wallet_id, plan_key, monthly_cents, net_cents, status, cancel_at_period_end, current_period_end, past_due_since, discount_cents, pending_plan_key, pending_plan_at, pending_plan_from")
      .eq("member_id", member.id)
      // `incomplete` is the first-payment state for a self-serve on-chain membership. It must render the
      // invoice/payment card even though no access is granted until the transfer is credited.
      .in("status", ["active", "trialing", "past_due", "incomplete"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    subscription = data;
  }

  // Ask once whether to be in the member directory (lib/memberDirectory.ts), of a member who could be listed.
  let askDirectory = false;
  if (member && member.show_in_directory == null && !member.disabled) {
    const { data: paying } = await own
      .from("subscriptions")
      .select("status, monthly_cents")
      .eq("member_id", member.id)
      .in("status", PAYING_STATUSES);
    askDirectory = isListed({ ...member, show_in_directory: true } as Parameters<typeof isListed>[0], paying ?? []);
  }

  let onchainWallet: PortalHomeView["onchainWallet"] = null;
  let onchainInvoice: PortalOnchainInvoice | null = null;
  if (subscription?.payment_rail === "onchain") {
    const [walletResult, invoiceResult] = await Promise.all([
      subscription.wallet_id
        ? service.from("member_wallets").select("address, verification_method").eq("id", subscription.wallet_id).is("revoked_at", null).maybeSingle()
        : Promise.resolve({ data: null }),
      service.from("onchain_invoices")
        .select("id, amount_cents, amount_usdc_micros, due_at, status, submitted_tx_hash, coupon_code, coupon_discount_cents")
        .eq("subscription_id", subscription.id)
        .in("status", ["open", "submitted", "detected", "exception"])
        .order("due_at", { ascending: true }).limit(1).maybeSingle(),
    ]);
    onchainWallet = walletResult.data;
    onchainInvoice = invoiceResult.data;
  }

  // A wallet can stay linked with no crypto membership behind it (a canceled membership, a card member, a test
  // account). Show it so it can be removed.
  let idleWallet: PortalHomeView["idleWallet"] = null;
  if (member && subscription?.payment_rail !== "onchain") {
    const { data } = await own
      .from("member_wallets")
      .select("id, address")
      .eq("member_id", member.id)
      .is("revoked_at", null)
      .maybeSingle();
    idleWallet = data;
  }

  // "In today" on the door panel: distinct members who unlocked since midnight at the hub (service client:
  // access_logs RLS hides other members from the signed-in one).
  const { data: hereNowRows } = await service
    .from("access_logs")
    .select("member_id")
    .eq("result", "granted")
    .gte("created_at", startOfDayIn("America/Denver").toISOString())
    .not("member_id", "is", null);
  const hereNowCount = new Set(((hereNowRows ?? []) as { member_id: number }[]).map((r) => r.member_id)).size;

  // Install-prompt eligibility: don't nag first-time visitors before they've used the space once. Eligible iff they
  // have a granted access_log entry OR their account is at least a day old.
  let installPromptEligible = false;
  if (member) {
    if (nowMs - new Date(member.created_at).getTime() > 24 * 60 * 60 * 1000) {
      installPromptEligible = true;
    } else {
      const { data: ownEntry } = await service
        .from("access_logs")
        .select("id")
        .eq("member_id", member.id)
        .eq("result", "granted")
        .limit(1)
        .maybeSingle();
      installPromptEligible = !!ownEntry;
    }
  }

  // A day-pass member's code live right now: the hero shows it, and it marks a visit day.
  let dayCode: ActiveDayCode | null = null;
  if (member?.member_type === "day_pass") {
    const { data } = await service
      .from("day_codes")
      .select("code, expires_at")
      .eq("member_id", member.id)
      .eq("is_active", true)
      .gt("expires_at", nowIso)
      .order("expires_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    dayCode = data;
  }

  return {
    nowMs,
    userEmail: who.userEmail,
    member,
    application: who.application,
    freeDayClaim,
    interestSignupAt,
    subscription,
    askDirectory,
    onchainWallet,
    onchainInvoice,
    idleWallet,
    hereNowCount,
    installPromptEligible,
    dayCode,
  };
}

/**
 * One real member's home as they see it, for an admin (lib/viewAs.ts): the same reads, through the service client,
 * then every code masked (their door PIN and any live day code become PLACEHOLDER_CODE) and the view audited
 * (`portal_viewed_as`, target the member). Null when there is no such member.
 */
export async function loadMemberPortalHome(memberId: number, adminMemberId: number, nowMs: number): Promise<PortalHomeView | null> {
  const service = createServiceClient();
  const { data: member } = await service.from("members").select("*").eq("id", memberId).maybeSingle();
  if (!member) return null;
  const { data: application } = member.supabase_user_id
    ? await service.from("applications").select("status, email, membership_interest")
      .eq("supabase_user_id", member.supabase_user_id).order("created_at", { ascending: false }).limit(1).maybeSingle()
    : { data: null };

  // Audit before anything is shown: no row, no view.
  const audit = await logAction({
    action: AuditAction.PORTAL_VIEWED_AS,
    actorMemberId: adminMemberId,
    target: { table: "members", id: memberId },
    payload: {},
  }, service);
  if (!audit.ok) throw new Error(`Couldn't record the view: ${audit.reason ?? "unknown"}`);

  const view = await loadPortalHome(
    { own: service, service },
    { member: toPortalMember(member), application, userId: member.supabase_user_id ?? null, userEmail: member.email ?? null },
    nowMs,
  );
  return maskCodes({ ...view, preview: true });
}

/** Only the fields the home uses, copied one by one, so a wider `select("*")` can't carry more into the view. */
export function toPortalMember(row: PortalMember): PortalMember {
  return {
    id: row.id,
    name: row.name,
    member_type: row.member_type,
    pin_code: row.pin_code,
    created_at: row.created_at,
    is_coop_member: row.is_coop_member,
    is_admin: row.is_admin,
    disabled: row.disabled,
    day_passes_balance: row.day_passes_balance,
    approved_for_daily: row.approved_for_daily,
    profile_photo_url: row.profile_photo_url,
    bio: row.bio,
    telegram_username: row.telegram_username,
    show_in_directory: row.show_in_directory,
  };
}

/** A preview never carries a real door code: the PIN and a live day code become the placeholder. */
export function maskCodes(view: PortalHomeView): PortalHomeView {
  return {
    ...view,
    member: view.member ? { ...view.member, pin_code: view.member.pin_code ? PLACEHOLDER_CODE : null } : null,
    dayCode: view.dayCode ? { code: PLACEHOLDER_CODE, expires_at: view.dayCode.expires_at } : null,
  };
}
