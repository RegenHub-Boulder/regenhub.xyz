import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Member } from "@/lib/supabase/types";

export type AdminUser = {
  // From auth.users
  authId: string;
  email: string;
  lastSignIn: string | null;
  createdAt: string;
  // From members table (if linked)
  member: Member | null;
};

export type AdminUsersResponse = {
  // Auth users (with or without a member row)
  users: AdminUser[];
  // Members with no auth account (legacy / Telegram-only)
  legacyMembers: Member[];
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

  // Fetch all member rows
  const supabase = await createClient();
  const { data: members } = await supabase
    .from("members")
    .select("*")
    .order("name");

  const memberByAuthId = new Map<string, Member>();
  const memberIdsWithAuth = new Set<number>();

  for (const m of members ?? []) {
    if (m.supabase_user_id) {
      memberByAuthId.set(m.supabase_user_id, m);
      memberIdsWithAuth.add(m.id);
    }
  }

  const users: AdminUser[] = (authData.users ?? []).map((u) => ({
    authId: u.id,
    email: u.email ?? "",
    lastSignIn: u.last_sign_in_at ?? null,
    createdAt: u.created_at,
    member: memberByAuthId.get(u.id) ?? null,
  }));

  // Members that have no linked auth account
  const legacyMembers = (members ?? []).filter((m) => !m.supabase_user_id);

  // Sort: unlinked auth users first (needs attention), then linked, then legacy
  users.sort((a, b) => {
    if (!a.member && b.member) return -1;
    if (a.member && !b.member) return 1;
    return a.email.localeCompare(b.email);
  });

  return NextResponse.json({ users, legacyMembers } satisfies AdminUsersResponse);
}
