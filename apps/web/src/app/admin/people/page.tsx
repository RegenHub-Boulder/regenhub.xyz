import { redirect } from "next/navigation";
import { requireApprovalsViewer } from "@/lib/admin";
import { loginUrlFor } from "@/lib/safeNext";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { InterestsSection, type InterestFilter } from "@/components/admin/InterestsSection";
import { ApplicationsFilter } from "@/components/admin/ApplicationsFilter";
import { FreeDaysList } from "@/components/admin/FreeDaysList";
import { readFreeDays } from "@/lib/freeDayData";
import { freeDayRuleWords } from "@/lib/freeDayRule";
import { FREE_DAY_GROUPS, type FreeDayGroup } from "@/lib/freeDayFunnel";
import { PeopleTabs, type PeopleTab } from "@/components/admin/PeopleTabs";
import { peoplePending } from "@/lib/peoplePending";
import type { Interest } from "@/lib/supabase/types";
import type { JoinApplication } from "@/components/admin/ApplicationActions";

export const metadata = { title: "People — Admin" };

type FunnelTab = Exclude<PeopleTab, "members">;
const FUNNEL_TABS: FunnelTab[] = ["applications", "freedays", "interests"];
/** A co-op member who isn't a site admin: the two tabs with something to approve. */
const APPROVER_TABS: FunnelTab[] = ["applications", "freedays"];

/**
 * People: from someone hearing about RegenHub to becoming a member. Opens on Applications (the tab with decisions),
 * then Free days and Interests; Members is the fourth tab (/admin/members). Each tab is its own URL
 * (?tab=…) and reads only its own rows. Was /admin/pipeline, which redirects here.
 *
 * Who (T-482, migration 074): site admins see every tab; a co-op member who isn't a site admin reaches Applications
 * and Free days to vouch and approve (lib/approval.ts canApproveOnSite), nothing else. A site admin who isn't a co-op
 * member sees the lists with "Co-op members approve" in place of the buttons. Outside app/admin/(staff) for that.
 */
export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; linked?: string; show?: string }>;
}) {
  const viewer = await requireApprovalsViewer();
  if (!viewer) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    redirect(user ? "/portal" : loginUrlFor((await headers()).get("x-pathname")));
  }
  const { isAdmin, canApprove } = viewer.member;
  const params = await searchParams;
  const tabs = isAdmin ? FUNNEL_TABS : APPROVER_TABS;
  const tab: FunnelTab = tabs.includes(params.tab as FunnelTab) ? (params.tab as FunnelTab) : "applications";

  const supabase = await createClient();
  const admin = createServiceClient();
  const pending = await peoplePending(admin);

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
    const { placed, counts } = await readFreeDays(admin);
    const show: FreeDayGroup = FREE_DAY_GROUPS.some((g) => g.key === params.show) ? (params.show as FreeDayGroup) : "review";
    body = (
      <div className="space-y-4">
        <p className="text-sm text-muted" data-testid="free-day-rule">{freeDayRuleWords()} A code is good for that one day, until 6 PM.</p>
        <FreeDaysList placed={placed} counts={counts} show={show} canApprove={canApprove} />
      </div>
    );
  } else {
    // The service client: a co-op member who isn't a site admin reads this list too (the gate is above).
    const { data } = await admin.from("applications").select("*").order("created_at", { ascending: false });
    const apps = (data ?? []) as JoinApplication[];
    // Names for who they said knows them, who vouched, and who decided.
    const ids = new Set<number>();
    for (const a of apps) {
      for (const id of [a.known_by_member_id, a.vouched_by, a.approved_by, a.rejected_by]) if (id) ids.add(id);
    }
    let names: Record<number, string> = {};
    if (ids.size > 0) {
      const { data: people } = await admin.from("members").select("id, name").in("id", [...ids]);
      names = Object.fromEntries((people ?? []).map((m) => [m.id, m.name]));
    }
    const waiting = apps.filter((a) => a.status === "pending");
    body = (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {waiting.length} waiting · {waiting.filter((a) => !a.vouched_by && !a.vouched_by_telegram_id).length} need a vouch.
          Someone who knows them vouches, then one approval: anyone in the members&apos; chat, or a co-op member here.
          They pick a day plan themselves.{isAdmin ? " Desks and custom prices are on each member’s page." : ""}
        </p>
        {/* eslint-disable-next-line react-hooks/purity -- server component, renders once per request */}
        <ApplicationsFilter applications={apps} names={names} nowMs={Date.now()} canApprove={canApprove} isAdmin={isAdmin} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PeopleTabs active={tab} pending={pending} only={isAdmin ? undefined : APPROVER_TABS} />
      {body}
    </div>
  );
}
