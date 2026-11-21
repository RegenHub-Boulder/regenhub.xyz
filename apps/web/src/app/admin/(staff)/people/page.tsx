import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { InterestsSection, type InterestFilter } from "@/components/admin/InterestsSection";
import { ApplicationsFilter } from "@/components/admin/ApplicationsFilter";
import { ClaimsFilter } from "@/components/admin/ClaimsFilter";
import { PeopleTabs, type PeopleTab } from "@/components/admin/PeopleTabs";
import { peoplePending } from "@/lib/peoplePending";
import type { Interest, Application } from "@/lib/supabase/types";

export const metadata = { title: "People — Admin" };

type FunnelTab = Exclude<PeopleTab, "members">;
const FUNNEL_TABS: FunnelTab[] = ["applications", "freedays", "interests"];

/**
 * People: from someone hearing about RegenHub to becoming a member. Opens on Applications (the tab with decisions),
 * then Free days and Interests; Members is the fourth tab (/admin/members). Each tab is its own URL
 * (?tab=…) and reads only its own rows. Was /admin/pipeline, which redirects here.
 */
export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; linked?: string }>;
}) {
  if (!await requireAdmin()) redirect("/portal");
  const params = await searchParams;
  const tab: FunnelTab = FUNNEL_TABS.includes(params.tab as FunnelTab) ? (params.tab as FunnelTab) : "applications";

  const supabase = await createClient();
  const admin = createServiceClient();
  const pending = await peoplePending(supabase, admin);

  let body: React.ReactNode;
  if (tab === "interests") {
    // The interests filter rides on the same URL as the tab.
    const filter: InterestFilter =
      params.linked === "true" ? "linked" : params.linked === "false" ? "unlinked" : "all";
    const query = supabase.from("interests").select("*").order("created_at", { ascending: false });
    const [{ data: rows }, { data: all }] = await Promise.all([
      filter === "linked" ? query.not("member_id", "is", null) : filter === "unlinked" ? query.is("member_id", null) : query,
      supabase.from("interests").select("member_id"),
    ]);
    const total = all?.length ?? 0;
    const linkedCount = all?.filter((r) => r.member_id !== null).length ?? 0;
    const filterHref = (f: InterestFilter): string => {
      const q = new URLSearchParams({ tab: "interests" });
      if (f === "linked") q.set("linked", "true");
      if (f === "unlinked") q.set("linked", "false");
      return `/admin/people?${q.toString()}`;
    };
    body = (
      <InterestsSection
        interests={(rows ?? []) as Interest[]}
        total={total}
        linkedCount={linkedCount}
        unlinkedCount={total - linkedCount}
        filter={filter}
        filterHref={filterHref}
      />
    );
  } else if (tab === "freedays") {
    const { data } = await admin.from("free_day_claims").select("*").order("created_at", { ascending: false });
    const claims = (data ?? []) as Array<{
      id: number;
      email: string;
      name: string;
      claimed_date: string;
      status: string;
      created_at: string;
      about?: string | null;
      why_join?: string | null;
      invite_code?: string | null;
    }>;
    body = (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {claims.length} total · {claims.filter((c) => c.status === "pending").length} pending review
        </p>
        <ClaimsFilter claims={claims} />
      </div>
    );
  } else {
    const { data } = await supabase.from("applications").select("*").order("created_at", { ascending: false });
    const apps = (data ?? []) as Application[];
    // Who approved or rejected each one, by name.
    const adminIds = new Set<number>();
    for (const a of apps) {
      if (a.approved_by) adminIds.add(a.approved_by);
      if (a.rejected_by) adminIds.add(a.rejected_by);
    }
    let adminNames: Record<number, string> = {};
    if (adminIds.size > 0) {
      const { data: admins } = await supabase.from("members").select("id, name").in("id", [...adminIds]);
      adminNames = Object.fromEntries((admins ?? []).map((m) => [m.id, m.name]));
    }
    body = (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {apps.length} total · {apps.filter((a) => a.status === "pending").length} pending review
        </p>
        <ApplicationsFilter applications={apps} adminNames={adminNames} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PeopleTabs active={tab} pending={pending} />
      {body}
    </div>
  );
}
