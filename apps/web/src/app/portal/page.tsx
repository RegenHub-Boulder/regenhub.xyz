import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { isSyntheticEmail } from "@/lib/regenos/syntheticEmail";
import { PortalHome } from "@/components/portal/PortalHome";
import { loadMemberPortalHome, loadPortalHome, toPortalMember } from "@/lib/portalHome";
import { currentViewAs } from "@/lib/viewAsServer";
import { portalFixture } from "@/lib/portalFixtures";

export default async function PortalPage() {
  // An admin viewing the portal as someone else (lib/viewAs.ts): a fictional member built in memory, or one real
  // member read-only with codes masked and the view audited. Nothing of the admin's own is read or shown.
  const viewAs = await currentViewAs();
  // eslint-disable-next-line react-hooks/purity -- server component, renders once per request
  const nowMs = Date.now();
  if (viewAs) {
    if (viewAs.target.kind === "fixture") {
      const fixture = portalFixture(viewAs.target.key);
      if (!fixture) notFound();
      return <PortalHome view={fixture.view(nowMs)} />;
    }
    const view = await loadMemberPortalHome(viewAs.target.memberId, viewAs.admin.id, nowMs);
    if (!view) notFound();
    return <PortalHome view={view} />;
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const [memberResult, applicationResult] = await Promise.all([
    supabase.from("members").select("*").eq("supabase_user_id", user.id).single(),
    supabase.from("applications").select("*").eq("supabase_user_id", user.id).single(),
  ]);
  let member = memberResult.data;
  const application = applicationResult.data;

  // Auto-link: if no member found by supabase_user_id, try matching by verified email.
  // This handles the case where a member was created via Telegram bot (no supabase_user_id)
  // and then signs in on the web with the same email.
  const service = createServiceClient();
  if (!member && user.email && !isSyntheticEmail(user.email)) {
    const { data: matched } = await service
      .from("members")
      .select("*")
      .eq("email", user.email)
      .is("supabase_user_id", null)
      .single();

    if (matched) {
      // Link this member to the authenticated user
      await service
        .from("members")
        .update({ supabase_user_id: user.id })
        .eq("id", matched.id);
      member = { ...matched, supabase_user_id: user.id };
    }
  }

  const view = await loadPortalHome(
    // The member's own rows through their own (RLS) client; the service client only where RLS hides what the page
    // needs (free-day claims, wallets behind a crypto membership, today's door count, day codes).
    { own: supabase as unknown as typeof service, service },
    {
      member: member ? toPortalMember(member) : null,
      application,
      userId: user.id,
      userEmail: user.email && !isSyntheticEmail(user.email) ? user.email : null,
    },
    nowMs,
  );
  return <PortalHome view={view} />;
}
