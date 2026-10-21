import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { withWebLockWriter } from "@/lib/lockWriter";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { actorIdFromAuthUid } from "@/lib/auditLog";
import { CancelMembershipError, cancelMembership, type CancelMode } from "@/lib/membershipCancel";

interface CancelBody {
  mode?: CancelMode;
  reason?: string;
  void_open_invoices?: boolean;
}

/**
 * POST /api/admin/members/[id]/cancel-membership
 *
 * Admin cancels a member's Stripe or on-chain membership, now or at period
 * end, optionally voiding open unpaid invoices. See lib/membershipCancel.ts.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!await requireAdmin()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const memberId = Number.parseInt((await ctx.params).id, 10);
  const body = (await req.json().catch(() => null)) as CancelBody | null;
  if (!memberId) return NextResponse.json({ error: "Invalid member id" }, { status: 400 });
  if (body?.mode !== "now" && body?.mode !== "period_end") {
    return NextResponse.json({ error: "mode must be \"now\" or \"period_end\"" }, { status: 400 });
  }
  const mode = body.mode;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;

  const run = async () => {
    const admin = createServiceClient();
    try {
      const result = await cancelMembership(admin, {
        memberId,
        actorMemberId: await actorIdFromAuthUid(user.id, admin),
        mode,
        reason,
        voidOpenInvoices: body.void_open_invoices === true,
      });
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof CancelMembershipError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error("[CancelMembership] Failed:", error);
      return NextResponse.json({ error: "Cancellation failed partway. Check the member's billing, then try again; repeating is safe." }, { status: 500 });
    }
  };

  // Cancel now clears the door code: take the PIN-writer reservation first so
  // a busy writer fails before any billing change.
  return mode === "now" ? withWebLockWriter(run) : run();
}
