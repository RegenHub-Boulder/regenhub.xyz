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
          {/* Desktop table */}
          <div className="glass-panel overflow-hidden hidden sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-muted">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Interest</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Applied</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => (
                  <tr key={app.id} className="border-b border-white/5">
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium">{app.name}</p>
                        {app.about && (
                          <p className="text-xs text-muted mt-0.5 line-clamp-1">{app.about}</p>
                        )}
                        {app.why_join && (
                          <p className="text-xs text-muted/70 mt-0.5 line-clamp-1 italic">
                            &ldquo;{app.why_join}&rdquo;
                          </p>
                        )}
                        {app.admin_notes && (
                          <p className="text-xs text-sage mt-1">
                            Note: {app.admin_notes}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted text-xs">{app.email}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="text-xs border-white/20 text-muted">
                        {interestLabels[app.membership_interest] ?? app.membership_interest}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={`text-xs ${statusStyle[app.status]}`}>
                        {app.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted text-xs whitespace-nowrap">
                      {new Date(app.created_at).toLocaleDateString("en-US", {
                        timeZone: "America/Denver",
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <ApplicationActions
                        applicationId={app.id}
                        currentStatus={app.status}
                        adminNotes={app.admin_notes}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="space-y-3 sm:hidden">
            {apps.map((app) => (
              <div key={app.id} className="glass-panel p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{app.name}</p>
                    <p className="text-xs text-muted mt-0.5">{app.email}</p>
                  </div>
                  <Badge variant="outline" className={`text-xs shrink-0 ${statusStyle[app.status]}`}>
                    {app.status}
                  </Badge>
                </div>
                {app.about && (
                  <p className="text-sm text-muted">{app.about}</p>
                )}
                {app.why_join && (
                  <p className="text-sm text-muted/70 italic">&ldquo;{app.why_join}&rdquo;</p>
                )}
                <div className="flex items-center gap-2 text-xs text-muted">
                  <Badge variant="outline" className="text-xs border-white/20 text-muted">
                    {interestLabels[app.membership_interest] ?? app.membership_interest}
                  </Badge>
                  <span>·</span>
                  <span>
                    {new Date(app.created_at).toLocaleDateString("en-US", {
                      timeZone: "America/Denver",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>
                {app.admin_notes && (
                  <p className="text-xs text-sage">Note: {app.admin_notes}</p>
                )}
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
