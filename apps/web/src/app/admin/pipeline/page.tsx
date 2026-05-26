import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { AdminTabs, type TabDef } from "@/components/admin/AdminTabs";
import { InterestsSection, type InterestFilter } from "@/components/admin/InterestsSection";
import { ApplicationsFilter } from "@/components/admin/ApplicationsFilter";
import { ClaimsFilter } from "@/components/admin/ClaimsFilter";
import type { Interest, Application } from "@/lib/supabase/types";

export const metadata = { title: "Pipeline — Admin" };

type PipelineTab = "interests" | "freedays" | "applications";

const TABS_BASE: { key: PipelineTab; label: string }[] = [
  { key: "interests",    label: "Interests" },
  { key: "freedays",     label: "Free Days" },
  { key: "applications", label: "Applications" },
];

function pendingBadge(count: number) {
  if (count <= 0) return null;
  return (
    <span className="text-xs bg-amber-500/20 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded-full">
      {count}
    </span>
  );
}

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; linked?: string }>;
}) {
  const params = await searchParams;

  // Parse the interests filter from the same URL (carried through the tab)
  const interestFilter: InterestFilter =
    params.linked === "true" ? "linked"
    : params.linked === "false" ? "unlinked"
    : "all";

  const supabase = await createClient();
  const admin = createServiceClient();

  // Fetch all three datasets in parallel — server-rendered once per request
  const interestsQuery = supabase
    .from("interests")
    .select("*")
    .order("created_at", { ascending: false });

  const interestsBuilder =
    interestFilter === "linked"
      ? interestsQuery.not("member_id", "is", null)
      : interestFilter === "unlinked"
        ? interestsQuery.is("member_id", null)
        : interestsQuery;

  const [
    { data: filteredInterests },
    { data: allInterestsCounts },
    { data: applicationsData },
    { data: claimsData },
  ] = await Promise.all([
    interestsBuilder,
    supabase.from("interests").select("member_id"),
    supabase
      .from("applications")
      .select("*")
      .order("created_at", { ascending: false }),
    admin
      .from("free_day_claims")
      .select("*")
      .order("created_at", { ascending: false }),
  ]);

  const interests = (filteredInterests ?? []) as Interest[];
  const total = allInterestsCounts?.length ?? 0;
  const linkedCount = allInterestsCounts?.filter((r) => r.member_id !== null).length ?? 0;
  const unlinkedCount = total - linkedCount;

  const apps = (applicationsData ?? []) as Application[];
  const pendingApps = apps.filter((a) => a.status === "pending").length;

  const claims = (claimsData ?? []) as Array<{
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
  const pendingClaims = claims.filter((c) => c.status === "pending").length;

  // Resolve admin names for application audit display (mirrors /admin/applications page)
  const adminIds = new Set<number>();
  for (const a of apps) {
    if (a.approved_by) adminIds.add(a.approved_by);
    if (a.rejected_by) adminIds.add(a.rejected_by);
  }
  let adminNames: Record<number, string> = {};
  if (adminIds.size > 0) {
    const { data: admins } = await supabase
      .from("members")
      .select("id, name")
      .in("id", [...adminIds]);
    adminNames = Object.fromEntries((admins ?? []).map((m) => [m.id, m.name]));
  }

  const tabs: TabDef<PipelineTab>[] = TABS_BASE.map((t) => ({
    ...t,
    badge:
      t.key === "freedays"
        ? pendingBadge(pendingClaims)
        : t.key === "applications"
          ? pendingBadge(pendingApps)
          : null,
  }));

  // Helper for interest filter links inside the tab — preserve tab=interests + carry filter
  const filterHref = (f: InterestFilter): string => {
    const q = new URLSearchParams();
    q.set("tab", "interests");
    if (f === "linked") q.set("linked", "true");
    if (f === "unlinked") q.set("linked", "false");
    return `/admin/pipeline?${q.toString()}`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-forest">Pipeline</h1>
        <p className="text-muted text-sm mt-1">
          The funnel — from someone hearing about RegenHub to becoming a member.
        </p>
      </div>

      <AdminTabs<PipelineTab> tabs={tabs}>
        {{
          interests: (
            <InterestsSection
              interests={interests}
              total={total}
              linkedCount={linkedCount}
              unlinkedCount={unlinkedCount}
              filter={interestFilter}
              filterHref={filterHref}
            />
          ),
          freedays: (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                {claims.length} total · {pendingClaims} pending review
              </p>
              <ClaimsFilter claims={claims} />
            </div>
          ),
          applications: (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                {apps.length} total · {pendingApps} pending review
              </p>
              <ApplicationsFilter applications={apps} adminNames={adminNames} />
            </div>
          ),
        }}
      </AdminTabs>
    </div>
  );
}
