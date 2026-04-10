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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-forest">Applications</h1>
        <p className="text-muted text-sm mt-1">
          {apps.length} total · {pendingCount} pending review
        </p>
      </div>
      <ApplicationsFilter applications={apps} />
    </div>
  );
}
