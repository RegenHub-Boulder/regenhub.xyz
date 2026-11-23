import { NextResponse } from "next/server";
import { requireAdminMember } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { sameSiteForm } from "@/lib/techne/guard";
import { siteOrigin } from "@/lib/techne/config";
import { portalFixture } from "@/lib/portalFixtures";
import { VIEW_AS_COOKIE, VIEW_AS_TTL_SECONDS, viewAsCookieValue, type ViewAsTarget } from "@/lib/viewAs";

/**
 * Enter (or switch) a portal preview (lib/viewAs.ts): a plain form post from /admin/view-as (`fixture`) or a member's
 * admin page (`member_id`). Only an active admin; the cookie names them, and every read of it checks again.
 * Then on to /portal. The proxy lets this path through while a preview is on, so an admin can switch views.
 */
export async function POST(request: Request) {
  const admin = await requireAdminMember();
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const crossSite = sameSiteForm(request);
  if (crossSite) return crossSite;

  const input = await readInput(request);
  let target: ViewAsTarget | null = null;
  if (input.fixture && portalFixture(input.fixture)) {
    target = { kind: "fixture", key: input.fixture };
  } else if (input.memberId) {
    const { data } = await createServiceClient().from("members").select("id").eq("id", input.memberId).maybeSingle();
    if (data) target = { kind: "member", memberId: data.id };
  }
  if (!target) return NextResponse.json({ error: "Pick a kind of member, or a member who exists." }, { status: 400 });

  const response = NextResponse.redirect(new URL("/portal", siteOrigin()), 303);
  response.cookies.set(VIEW_AS_COOKIE, viewAsCookieValue(target, admin.user.id, Date.now()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: VIEW_AS_TTL_SECONDS,
  });
  return response;
}

async function readInput(request: Request): Promise<{ fixture: string | null; memberId: number | null }> {
  const type = request.headers.get("content-type") ?? "";
  let fixture: unknown = null;
  let member: unknown = null;
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    fixture = body.fixture;
    member = body.member_id;
  } else {
    const form = await request.formData().catch(() => null);
    fixture = form?.get("fixture") ?? null;
    member = form?.get("member_id") ?? null;
  }
  const memberId = Number(member);
  return {
    fixture: typeof fixture === "string" ? fixture : null,
    memberId: Number.isSafeInteger(memberId) && memberId > 0 ? memberId : null,
  };
}
