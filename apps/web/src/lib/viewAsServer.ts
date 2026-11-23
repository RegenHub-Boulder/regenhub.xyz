import { cache } from "react";
import { cookies } from "next/headers";
import { requireAdminMember } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { memberTypeLabel } from "@/lib/memberTypeLabel";
import { portalFixture } from "@/lib/portalFixtures";
import { VIEW_AS_COOKIE, parseViewAsCookie, type ViewAsTarget } from "@/lib/viewAs";

export interface ActiveViewAs {
  target: ViewAsTarget;
  /** The admin doing the viewing (their own member row): the audit's actor. */
  admin: { id: number; name: string };
}

/**
 * The preview this request is in, or null. The cookie alone grants nothing: it counts only while the signed-in user is
 * the admin who set it AND is still an active admin (`requireAdminMember`: `is_admin` and not disabled), read live
 * on every request. No cookie costs no read. Once per request (React `cache`): the layout and the page share it.
 */
export const currentViewAs = cache(async (): Promise<ActiveViewAs | null> => {
  const parsed = parseViewAsCookie((await cookies()).get(VIEW_AS_COOKIE)?.value, Date.now());
  if (!parsed) return null;
  const viewer = await requireAdminMember();
  if (!viewer || viewer.user.id !== parsed.adminUserId) return null;
  return { target: parsed.target, admin: viewer.member };
});

/** A preview cookie that counts for nobody here (its admin signed out or someone else signed in): the frame offers Exit,
 *  since the proxy still pauses writes while it is set. */
export async function strandedViewAs(): Promise<boolean> {
  return !!parseViewAsCookie((await cookies()).get(VIEW_AS_COOKIE)?.value, Date.now()) && !(await currentViewAs());
}

/** What the frame shows in a preview: the bar's words and the viewed member's menu. Generic views read nothing. */
export async function previewFrame(viewAs: ActiveViewAs): Promise<{ label: string; memberType: string | null; steward: boolean }> {
  if (viewAs.target.kind === "fixture") {
    const fixture = portalFixture(viewAs.target.key);
    return { label: fixture?.label ?? "a member", memberType: fixture?.nav.memberType ?? null, steward: !!fixture?.nav.steward };
  }
  const { data } = await createServiceClient().from("members").select("name, member_type")
    .eq("id", viewAs.target.memberId).maybeSingle();
  // A real member's Techne role isn't looked up (no Techne call from a preview), so Events stays out of their menu.
  return {
    label: data ? `${data.name}, ${memberTypeLabel(data.member_type).toLowerCase()} member` : "a member",
    memberType: data?.member_type ?? null,
    steward: false,
  };
}

