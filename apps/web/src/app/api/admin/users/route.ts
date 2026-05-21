import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Application, Member } from "@/lib/supabase/types";

export type AdminUserSubscription = {
  plan_key: string;
  monthly_cents: number;
  status: string;
  cancel_at_period_end: boolean;
};

export type AdminUser = {
  // From auth.users
  authId: string;
  email: string;
  lastSignIn: string | null;
  createdAt: string;
  // From members table (if linked)
  member: Member | null;
  // From applications table (if submitted)
  application: Application | null;
  // Active subscription if any (active|trialing|past_due)
  subscription: AdminUserSubscription | null;
};

export type AdminUsersResponse = {
  // Auth users (with or without a member row)
  users: AdminUser[];
  // Members with no auth account (legacy / Telegram-only)
  legacyMembers: (Member & { subscription: AdminUserSubscription | null })[];
};

export async function GET() {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const serviceClient = createServiceClient();

  // Fetch all auth users (paginated up to 1000 — plenty for now)
  const { data: authData, error: authError } = await serviceClient.auth.admin.listUsers({
    perPage: 1000,
  });
  if (authError) {
    console.error("[AdminUsers] Failed to list auth users:", authError);
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }

  // Fetch all member rows + applications + active subscriptions in parallel
  const supabase = await createClient();
  const [{ data: members }, { data: applications }, { data: subs }] = await Promise.all([
    supabase.from("members").select("*").order("name"),
    serviceClient.from("applications").select("*").order("created_at", { ascending: false }),
    supabase
      .from("subscriptions")
      .select("member_id, plan_key, monthly_cents, status, cancel_at_period_end")
      .in("status", ["active", "trialing", "past_due"]),
  ]);

  const memberByAuthId = new Map<string, Member>();
  for (const m of members ?? []) {
    if (m.supabase_user_id) memberByAuthId.set(m.supabase_user_id, m);
  }

  const appByAuthId = new Map<string, Application>();
  const appByEmail = new Map<string, Application>();
  for (const a of (applications as Application[] ?? [])) {
    if (a.supabase_user_id) appByAuthId.set(a.supabase_user_id, a);
    appByEmail.set(a.email.toLowerCase(), a);
  }

  // Member ID → subscription (one per member by design — invariant from the approval flow)
  const subByMemberId = new Map<number, AdminUserSubscription>();
  for (const s of subs ?? []) {
    subByMemberId.set(s.member_id, {
      plan_key: s.plan_key,
      monthly_cents: s.monthly_cents,
      status: s.status,
      cancel_at_period_end: s.cancel_at_period_end,
    });
  }

  const users: AdminUser[] = (authData.users ?? []).map((u) => {
    const member = memberByAuthId.get(u.id) ?? null;
    return {
      authId: u.id,
      email: u.email ?? "",
      lastSignIn: u.last_sign_in_at ?? null,
      createdAt: u.created_at,
      member,
      application: appByAuthId.get(u.id) ?? appByEmail.get((u.email ?? "").toLowerCase()) ?? null,
      subscription: member ? subByMemberId.get(member.id) ?? null : null,
    };
  });

  // Members that have no linked auth account (legacy / Telegram-only)
  const legacyMembers = (members ?? [])
    .filter((m) => !m.supabase_user_id)
    .map((m) => ({ ...m, subscription: subByMemberId.get(m.id) ?? null }));

  // Sort: unlinked auth users first (needs attention), then linked, then legacy
  users.sort((a, b) => {
    if (!a.member && b.member) return -1;
    if (a.member && !b.member) return 1;
    return a.email.localeCompare(b.email);
  });

  return NextResponse.json({ users, legacyMembers } satisfies AdminUsersResponse);
}
