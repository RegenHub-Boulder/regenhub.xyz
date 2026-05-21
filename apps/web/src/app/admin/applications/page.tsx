import { createClient } from "@/lib/supabase/server";
import { ApplicationsFilter } from "@/components/admin/ApplicationsFilter";
import type { Application } from "@/lib/supabase/types";

export default async function ApplicationsPage() {
  const supabase = await createClient();

  const { data: applications } = await supabase
    .from("applications")
    .select("*")
    .order("created_at", { ascending: false });

  const apps = (applications ?? []) as Application[];
  const pendingCount = apps.filter((a) => a.status === "pending").length;

  // Resolve admin names for the audit-trail surfaces (approved by / rejected by)
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-forest">Applications</h1>
        <p className="text-muted text-sm mt-1">
          {apps.length} total · {pendingCount} pending review
        </p>
      </div>
      <ApplicationsFilter applications={apps} adminNames={adminNames} />
    </div>
  );
}
