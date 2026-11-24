/**
 * Reads what "Where people drop off" (lib/leakFunnel.ts) counts, on top of the rows the scoreboard already read
 * (lib/scoreboardData.ts). Server only. Read-only everywhere, Stripe included: card periods are Stripe's paid
 * invoices, asked once per subscription per page load; if Stripe isn't configured or a read fails, every card row
 * falls back to months elapsed, and the notes say so.
 */
import type { createServiceClient } from "@/lib/supabase/admin";
import { readAll } from "@/lib/supabase/readAll";
import { mapLimit } from "@/lib/mapLimit";
import { membershipInvoices } from "@/lib/onchain/invoiceKind";
import { getStripe, isStripeConfigured } from "@/lib/stripe";
import { AuditAction } from "@/lib/auditLog";
import { rsvpPeople, type FollowupMember, type FollowupTechnePerson } from "@/lib/nightFollowups";
import type { FreeDayClaimRow } from "@/lib/freeDayFunnel";
import type { MemberRow, SubRow, TurnoutEvent } from "@/lib/scoreboard";
import {
  elapsedPeriods, leakFunnels, periodCandidates, type LeakFunnels, type LeakInput,
} from "@/lib/leakFunnel";

type Admin = ReturnType<typeof createServiceClient>;

/** Stripe invoices that bill a membership period. */
const PERIOD_REASONS = new Set(["subscription_create", "subscription_cycle"]);

const inChunks = async <T, R>(items: readonly T[], fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += 200) chunks.push(items.slice(i, i + 200));
  return (await mapLimit(chunks, 4, fn)).flat();
};

/** Passes an admin added on the member page (logged from T-497 on; see the add-passes route). Null when unreadable. */
async function readGifts(admin: Admin): Promise<LeakInput["gifts"]> {
  try {
    const rows = await readAll<{ target_id: string | null; payload: { amount?: unknown } | null; created_at: string }>("admin_actions",
      (f, t) => admin.from("admin_actions").select("id, target_id, payload, created_at").eq("action", AuditAction.PASSES_GRANTED)
        .eq("target_table", "members").order("id", { ascending: true }).range(f, t));
    return rows.flatMap((r) => {
      const id = Number(r.target_id);
      return Number.isInteger(id) && Number(r.payload?.amount ?? 1) > 0 ? [{ memberId: id, at: r.created_at }] : [];
    });
  } catch (e) {
    console.error("[leaks] gift read failed", e);
    return null;
  }
}

/** Who each RSVP's DID is: the members the scoreboard read, plus what their Techne sign-ins here recorded. */
async function rsvpWho(admin: Admin, members: readonly MemberRow[], dids: readonly string[]) {
  const people = dids.length === 0 ? [] : await inChunks(dids, async (chunk) => {
    const { data, error } = await admin.from("techne_people").select("did, handle, name, email, email_confirmed, member_id").in("did", chunk);
    // Before migration 068: members by DID only.
    if (error) {
      console.error("[leaks] techne_people read failed; members by DID only:", error.message);
      return [];
    }
    return (data ?? []) as FollowupTechnePerson[];
  });
  const asFollowup: FollowupMember[] = members.map((m) => ({
    id: m.id, name: m.name, email: m.email, did: m.did ?? null, member_type: m.member_type, disabled: m.disabled, show_in_directory: null,
  }));
  const person = rsvpPeople({ members: asFollowup, people });
  return (did: string) => {
    const p = person(did);
    return { memberId: p.member?.id ?? null, email: p.email ?? null };
  };
}

/** Paid membership invoices per USDC subscription. */
async function onchainPeriods(admin: Admin, ids: number[]): Promise<Map<number, number>> {
  const rows = await inChunks(ids, (chunk) => readAll<{ subscription_id: number }>("onchain_invoices", (from, to) =>
    membershipInvoices((kindColumn) => {
      const q = admin.from("onchain_invoices").select("id, subscription_id").eq("status", "paid").in("subscription_id", chunk);
      return (kindColumn ? q.eq("kind", "membership") : q).order("id", { ascending: true }).range(from, to);
    })));
  const out = new Map<number, number>();
  for (const r of rows) out.set(r.subscription_id, (out.get(r.subscription_id) ?? 0) + 1);
  return out;
}

/** Paid card periods per subscription: Stripe invoices paid with money in them that bill a period (create or cycle;
 *  not a proration or one-off). Null if Stripe can't be asked. */
async function stripePeriods(admin: Admin, ids: number[]): Promise<Map<number, number> | null> {
  if (ids.length === 0) return new Map();
  if (!isStripeConfigured()) return null;
  try {
    const rows = await inChunks(ids, async (chunk) => {
      const { data, error } = await admin.from("subscriptions").select("id, stripe_subscription_id").in("id", chunk);
      if (error) throw error;
      return (data ?? []) as { id: number; stripe_subscription_id: string | null }[];
    });
    const stripe = getStripe();
    const out = new Map<number, number>();
    await mapLimit(rows.filter((r) => r.stripe_subscription_id), 4, async (r) => {
      let n = 0;
      for await (const inv of stripe.invoices.list({ subscription: r.stripe_subscription_id!, status: "paid", limit: 100 })) {
        // A period: the first or a renewal, with money in it. A proration (a plan changed mid-month) or a one-off isn't.
        if ((inv.amount_paid ?? 0) > 0 && PERIOD_REASONS.has(inv.billing_reason ?? "")) n += 1;
      }
      out.set(r.id, n);
    });
    return out;
  } catch (e) {
    console.error("[leaks] Stripe invoice read failed; card periods by months elapsed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Every door's funnel. `events` is the collective's calendar with its going RSVPs (null when Techne couldn't be read:
 * the RSVP door shows as unread); `freeDays` the claims with their member (null when unreadable).
 */
export async function readLeakFunnels(admin: Admin, rows: {
  subs: readonly SubRow[];
  members: readonly MemberRow[];
  purchases: readonly { member_id: number | null; email: string | null; created_at: string }[];
  freeDays: readonly { claim: FreeDayClaimRow; memberId: number | null }[] | null;
}, events: readonly TurnoutEvent[] | null, now: Date): Promise<LeakFunnels> {
  const pastRsvps = events?.flatMap((e) => (e.startAt && Date.parse(e.startAt) < now.getTime()
    ? (e.goingDids ?? []).map((did) => ({ did, at: e.startAt! })) : [])) ?? null;
  const [gifts, rsvpPerson] = await Promise.all([
    readGifts(admin),
    rsvpWho(admin, rows.members, [...new Set((pastRsvps ?? []).map((r) => r.did))]),
  ]);
  const base: Omit<LeakInput, "paidPeriods" | "now" | "entries"> = {
    members: rows.members, subs: rows.subs, purchases: rows.purchases, gifts, rsvps: pastRsvps, rsvpPerson,
    claims: rows.freeDays?.map(({ claim, memberId }) => ({
      email: claim.email, memberId, status: claim.status, created_at: claim.created_at, activated_at: claim.activated_at ?? null,
    })) ?? null,
  };

  // Door entries of everyone through a door who has a member row (all time: a free day may be from March).
  const byEmail = new Map(rows.members.flatMap((m) => (m.email ? [[m.email.trim().toLowerCase(), m.id] as const] : [])));
  const ids = new Set<number>();
  const add = (id: number | null | undefined, email?: string | null) => {
    const m = id ?? (email ? byEmail.get(email.trim().toLowerCase()) : undefined);
    if (m != null) ids.add(m);
  };
  base.claims?.forEach((c) => add(c.memberId, c.email));
  rows.purchases.forEach((p) => add(p.member_id, p.email));
  gifts?.forEach((g) => add(g.memberId));
  pastRsvps?.forEach((r) => add(rsvpPerson(r.did).memberId, rsvpPerson(r.did).email));
  const entries = await inChunks([...ids], (chunk) => readAll<{ member_id: number; created_at: string }>("access_logs", (f, t) =>
    admin.from("access_logs").select("id, member_id, created_at").eq("result", "granted").in("member_id", chunk)
      .order("id", { ascending: true }).range(f, t)));

  const candidates = periodCandidates({ ...base, entries });
  const [onchain, card] = await Promise.all([
    onchainPeriods(admin, candidates.filter((s) => s.payment_rail === "onchain").map((s) => s.id)),
    stripePeriods(admin, candidates.filter((s) => s.payment_rail !== "onchain").map((s) => s.id)),
  ]);
  const paidPeriods = new Map<number, number>(onchain);
  for (const s of candidates) {
    if (s.payment_rail === "onchain") continue;
    paidPeriods.set(s.id, card ? card.get(s.id) ?? 0 : elapsedPeriods(s, now));
  }
  return leakFunnels({ ...base, entries, paidPeriods, now }, card ? "stripe" : "elapsed");
}
