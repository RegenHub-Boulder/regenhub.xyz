import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/admin";
import {
  setUserCode,
  clearUserCode,
  formatLockStatus,
  generateRandomCode,
  MEMBER_SLOT_MIN,
  MEMBER_SLOT_MAX,
  LOCK_FAILURE_MSG,
} from "@regenhub/shared";

const PERMANENT_TYPES = ["cold_desk", "hot_desk", "hub_friend"];

async function nextFreeSlot(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<number | null> {
  const { data } = await supabase
    .from("members")
    .select("pin_code_slot")
    .not("pin_code_slot", "is", null);
  const used = new Set((data ?? []).map((r) => r.pin_code_slot as number));
  for (let s = MEMBER_SLOT_MIN; s <= MEMBER_SLOT_MAX; s++) {
    if (!used.has(s)) return s;
  }
  return null;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();
  const { id } = await params;
  const body = await request.json();

  // Fetch current member state to detect upgrades
  const { data: current } = await supabase
    .from("members")
    .select("*")
    .eq("id", Number(id))
    .single();

  if (!current) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const allowed = [
    "name", "email", "member_type", "is_coop_member", "is_admin",
    "telegram_username", "ethereum_address", "pin_code_slot", "pin_code",
    "nfc_key_address", "bio", "skills", "disabled", "day_passes_balance",
  ] as const;

  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }

  // Canonical Telegram handle: bare, no "@" (migration 044); display adds it back.
  if ("telegram_username" in update) {
    update.telegram_username =
      String(update.telegram_username ?? "").trim().replace(/^@+/, "") || null;
  }

  // Auto-assign slot + code when upgrading from day_pass to a permanent type
  const newType = update.member_type as string | undefined;
  const isUpgrade =
    newType &&
    PERMANENT_TYPES.includes(newType) &&
    current.member_type === "day_pass" &&
    !current.pin_code_slot;

  if (isUpgrade) {
    // Only auto-assign if not explicitly provided in the request
    if (!("pin_code_slot" in update) || !update.pin_code_slot) {
      const slot = await nextFreeSlot(supabase);
      if (slot === null) {
        return NextResponse.json(
          { error: "No free PIN slots available (all 100 member slots in use)" },
          { status: 409 }
        );
      }
      update.pin_code_slot = slot;
    }

    if (!("pin_code" in update) || !update.pin_code) {
      update.pin_code = generateRandomCode();
    }
  }

  // Migration 031 revoked UPDATE on members from the authenticated role (anon
  // SDK lockdown), so admin writes must go through the service-role client.
  // The route is requireAdmin-gated and fields are whitelisted above, so this
  // is safe.
  const admin = createServiceClient();
  const { data, error } = await admin
    .from("members")
    .update(update)
    .eq("id", Number(id))
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Sync lock
  let lockStatus: string | null = null;

  if ("disabled" in update && data.disabled && data.pin_code_slot) {
    // Member was just disabled — clear their lock code
    try {
      const lockResults = await clearUserCode(data.pin_code_slot);
      lockStatus = formatLockStatus(lockResults);
    } catch (lockErr) {
      console.error("[AdminMember PATCH] Lock clear failed:", lockErr);
      lockStatus = `Member disabled but lock code could not be cleared — run Lock Sync. ${LOCK_FAILURE_MSG}`;
    }
  } else if (
    data.pin_code &&
    data.pin_code_slot &&
    !data.disabled &&
    (isUpgrade || "pin_code" in update || "pin_code_slot" in update)
  ) {
    // PIN was updated or member was upgraded — sync to lock
    try {
      const lockResults = await setUserCode(data.pin_code_slot, data.pin_code);
      lockStatus = formatLockStatus(lockResults);
    } catch (lockErr) {
      console.error("[AdminMember PATCH] Lock sync failed:", lockErr);
      lockStatus = `Member updated but lock sync failed — run Lock Sync. ${LOCK_FAILURE_MSG}`;
    }
  }

  return NextResponse.json({ member: data, lock_status: lockStatus });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();
  const { id } = await params;

  // Fetch the member first so we can clear their lock code and check for
  // state that deleting the member row would leave orphaned (see below).
  const { data: member } = await supabase
    .from("members")
    .select("pin_code_slot, email")
    .eq("id", Number(id))
    .single();

  // Clear the lock code if they have a slot assigned
  let lockStatus: string | null = null;
  if (member?.pin_code_slot) {
    try {
      const lockResults = await clearUserCode(member.pin_code_slot);
      lockStatus = formatLockStatus(lockResults);
    } catch (err) {
      console.error("[AdminMember DELETE] Failed to clear lock code:", err);
      lockStatus = `Could not clear door code from lock — run Lock Sync after deleting. ${LOCK_FAILURE_MSG}`;
    }
  }

  // Service-role client for the write (members DELETE/UPDATE are revoked from
  // the authenticated role — migration 031). Route is requireAdmin-gated.
  const admin = createServiceClient();

  // Deleting a member never touches auth.users or applications (see
  // migration 050) — if this email can still sign in, or has an application
  // on file, deleting the member row orphans that state. Non-blocking: warn
  // rather than refuse the delete. This check is a nice-to-have, not a hard
  // dependency — any failure here (RPC error, query error, thrown exception)
  // is logged and swallowed so the delete itself always proceeds.
  let warning: string | null = null;
  if (member?.email) {
    try {
      const [{ data: liveAuthId, error: rpcErr }, { data: staleApplications, error: appsErr }] = await Promise.all([
        admin.rpc("current_auth_user_for_email", { target_email: member.email }),
        admin.from("applications").select("id").eq("email", member.email).limit(1),
      ]);
      if (rpcErr) console.error("[AdminMember DELETE] stale-link guard rpc failed:", rpcErr);
      if (appsErr) console.error("[AdminMember DELETE] stale-link guard applications check failed:", appsErr);

      const canStillSignIn = !rpcErr && !!liveAuthId;
      const hasApplication = !appsErr && (staleApplications ?? []).length > 0;

      if (canStillSignIn && hasApplication) {
        warning =
          "This member's email can still sign in and has an application on file — deleting only removed the member record. If they sign in again they may land on an unlinked-application screen; use the stale-links tool to relink them if that happens.";
      } else if (canStillSignIn) {
        warning =
          "This member's email can still sign in — deleting only removed the member record. If they sign in again, use the stale-links tool to relink them if needed.";
      } else if (hasApplication) {
        warning =
          "This member has an application on file under the same email — deleting only removed the member record. The application still refers to it.";
      }
    } catch (err) {
      console.error("[AdminMember DELETE] stale-link guard failed:", err);
    }
  }

  const { error } = await admin
    .from("members")
    .delete()
    .eq("id", Number(id));

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    lock_status: lockStatus,
    ...(warning ? { warning } : {}),
  });
}
