/**
 * One approval, then desks (T-482 round 5, migration 072).
 *
 * A person is approved once (an application, vouched for by a member, approved by a steward: @regenhub/shared
 * joining.ts). Approved, they may buy any day plan ($30/$50/$100) themselves. A desk needs desk access, which a
 * co-op member (`canApproveOnSite`) turns on for a member who asked: the 24/7 door code is the trust step.
 *
 * Until 072 runs the new columns don't exist: reads select `*` and `approvalOf` falls back to the old pair
 * (approved_for_daily / approved_for_full); 072's trigger keeps both pairs equal for one release. Subtract: the
 * fallback and the old columns go in the follow-up that drops approved_for_* (owner: whoever runs 072).
 */
import { isDeskPlan } from "@/lib/plans";

export interface ApprovalRow {
  member_approved?: boolean | null;
  member_approved_at?: string | null;
  member_approved_by?: number | null;
  desk_access?: boolean | null;
  desk_access_at?: string | null;
  desk_access_by?: number | null;
  desk_asked_at?: string | null;
  approved_for_daily?: boolean | null;
  approved_for_daily_at?: string | null;
  approved_for_daily_by?: number | null;
  approved_for_full?: boolean | null;
  approved_for_full_at?: string | null;
  approved_for_full_by?: number | null;
}

export interface Approval {
  /** Approved as a member: may buy any day plan. */
  member: boolean;
  memberAt: string | null;
  memberBy: number | null;
  /** Desk access turned on: may buy a desk. */
  desk: boolean;
  deskAt: string | null;
  deskBy: number | null;
  /** When they asked about a desk from the portal (null = never, or before 072). */
  deskAskedAt: string | null;
}

/** Pure: what a member row says, from the new columns when they exist, else the old pair. */
export function approvalOf(row: ApprovalRow | null | undefined): Approval {
  if (!row) return { member: false, memberAt: null, memberBy: null, desk: false, deskAt: null, deskBy: null, deskAskedAt: null };
  if ("member_approved" in row) {
    return {
      member: !!row.member_approved || !!row.desk_access,
      memberAt: row.member_approved_at ?? null,
      memberBy: row.member_approved_by ?? null,
      desk: !!row.desk_access,
      deskAt: row.desk_access_at ?? null,
      deskBy: row.desk_access_by ?? null,
      deskAskedAt: row.desk_asked_at ?? null,
    };
  }
  const desk = !!row.approved_for_full;
  return {
    member: !!row.approved_for_daily || desk,
    memberAt: row.approved_for_daily_at ?? row.approved_for_full_at ?? null,
    memberBy: row.approved_for_daily_by ?? row.approved_for_full_by ?? null,
    desk,
    deskAt: row.approved_for_full_at ?? null,
    deskBy: row.approved_for_full_by ?? null,
    deskAskedAt: null,
  };
}

export const NOT_APPROVED = "You can pick a plan once you're approved. Apply at /apply: a member vouches, then we approve, within a day.";
export const NO_DESK_ACCESS = "Desks are for members: ask about one from your portal and a steward will talk with you.";

/** Whether this approval may buy this plan; the reason in words when not. One check for card and USDC. */
export function planGate(approval: Approval, planKey: string): { ok: true } | { ok: false; error: string } {
  if (isDeskPlan(planKey)) return approval.desk ? { ok: true } : { ok: false, error: approval.member ? NO_DESK_ACCESS : NOT_APPROVED };
  return approval.member ? { ok: true } : { ok: false, error: NOT_APPROVED };
}

type Flags = { is_admin?: boolean | null; is_ops_admin?: boolean | null; is_coop_member?: boolean | null; disabled?: boolean | null } | null | undefined;

/**
 * Who may approve and vouch ON THE SITE (Aaron, 11-24: "on the website, they need to be a co-op member"): a co-op
 * member, not disabled, admin or not. The one rule for People → Applications and Free days, the portal's vouch,
 * desk access and a desk's custom price on the member page (Aaron, 11-24: "co-op members should be able to approve
 * folks for hot desks"; desk access stays a site action, never the chat: it hands out a 24/7 door code), and the
 * routes behind them; migration 074's member_can_approve is the same rule in SQL. In the members' chat anyone
 * may approve (@regenhub/shared isMembersChat). A site admin who isn't a co-op member sees the lists, not the buttons.
 */
export function canApproveOnSite(m: Flags): boolean {
  return !!m && !m.disabled && !!m.is_coop_member;
}

/** What the site shows a site admin who may not approve, in place of the buttons. */
export const COOP_APPROVES = "Co-op members approve";

export const missingColumn = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "42703" || e.code === "PGRST204");

/** Column names for the one approval and desk access: the new pair, or the old one before 072. */
export const APPROVAL_COLUMNS = { member: "member_approved", desk: "desk_access" } as const;
export const OLD_APPROVAL_COLUMNS = { member: "approved_for_daily", desk: "approved_for_full" } as const;

/** Run a query naming the approval columns; before 072 (missing column) run it again with the old names. */
export async function withApprovalColumns<T extends { error: { code?: string; message?: string } | null }>(
  run: (cols: { member: string; desk: string }) => PromiseLike<T>,
): Promise<T> {
  const first = await run(APPROVAL_COLUMNS);
  if (!missingColumn(first.error)) return first;
  return run(OLD_APPROVAL_COLUMNS);
}

/**
 * Turn desk access on or off for a member (the member page, `canApproveOnSite` only). Writes the new columns, or the
 * old flag before 072. Turning it on also approves them as a member (a desk member is a member).
 */
export function deskAccessUpdate(on: boolean, by: number, now = new Date().toISOString()) {
  return {
    next: on
      ? { desk_access: true, desk_access_at: now, desk_access_by: by, member_approved: true }
      : { desk_access: false, desk_access_at: null, desk_access_by: null },
    old: on
      ? { approved_for_full: true, approved_for_full_at: now, approved_for_full_by: by, approved_for_daily: true }
      : { approved_for_full: false, approved_for_full_at: null, approved_for_full_by: null },
  };
}
