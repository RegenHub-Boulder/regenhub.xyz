import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { ApplicationActions } from "@/components/admin/ApplicationActions";
import type { Application, ApplicationStatus } from "@/lib/supabase/types";

const interestLabels: Record<string, string> = {
  daypass_single: "Day Pass",
  daypass_5pack: "5-Pack",
  hot_desk: "Hot Desk",
  reserved_desk: "Reserved Desk",
  community: "Community",
};

const statusStyle: Record<ApplicationStatus, string> = {
  pending: "border-amber-400/50 text-amber-400",
  approved: "border-emerald-400/50 text-emerald-400",
  rejected: "border-red-400/50 text-red-400",
};

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-forest">Applications</h1>
          <p className="text-muted text-sm mt-1">
            {apps.length} total · {pendingCount} pending review
          </p>
        </div>
      </div>

      {apps.length === 0 ? (
        <div className="glass-panel p-8 text-center text-muted">
          No applications yet.
        </div>
      ) : (
        <>
          {/* Application cards */}
          <div className="space-y-4">
            {apps.map((app) => (
              <div key={app.id} className="glass-panel p-5 space-y-4">
                {/* Header: name, meta, status */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h3 className="font-semibold text-lg">{app.name}</h3>
                    <Badge variant="outline" className={`text-xs ${statusStyle[app.status]}`}>
                      {app.status}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted">
                    <span>{app.email}</span>
                    <Badge variant="outline" className="text-xs border-white/20 text-muted">
                      {interestLabels[app.membership_interest] ?? app.membership_interest}
                    </Badge>
                    <span>
                      {new Date(app.created_at).toLocaleDateString("en-US", {
                        timeZone: "America/Denver",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                </div>

                {/* Questions & answers */}
                {(app.about || app.why_join) && (
                  <div className="grid sm:grid-cols-2 gap-4">
                    {app.about && (
                      <div>
                        <p className="text-xs text-muted mb-1 font-medium">What are you working on?</p>
                        <p className="text-sm text-foreground/80">{app.about}</p>
                      </div>
                    )}
                    {app.why_join && (
                      <div>
                        <p className="text-xs text-muted mb-1 font-medium">Why do you want to join?</p>
                        <p className="text-sm text-foreground/80">{app.why_join}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Admin notes */}
                {app.admin_notes && (
                  <p className="text-xs text-sage border-l-2 border-sage/30 pl-3">
                    {app.admin_notes}
                  </p>
                )}

                {/* Actions */}
                <ApplicationActions
                  applicationId={app.id}
                  currentStatus={app.status}
                  adminNotes={app.admin_notes}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
