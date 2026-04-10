"use client";

import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, X } from "lucide-react";
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

const statusTabs = ["all", "pending", "approved", "rejected"] as const;

export function ApplicationsFilter({ applications }: { applications: Application[] }) {
  const [activeTab, setActiveTab] = useState<string>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let result = applications;
    if (activeTab !== "all") {
      result = result.filter((a) => a.status === activeTab);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((a) =>
        a.name.toLowerCase().includes(q) ||
        a.email.toLowerCase().includes(q)
      );
    }
    return result;
  }, [applications, activeTab, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: applications.length };
    for (const app of applications) {
      c[app.status] = (c[app.status] ?? 0) + 1;
    }
    return c;
  }, [applications]);

  return (
    <div className="space-y-4">
      {/* Filter tabs */}
      <div className="flex flex-wrap gap-2">
        {statusTabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              activeTab === tab
                ? "bg-sage/20 text-sage border border-sage/30"
                : "bg-white/5 text-muted border border-white/10 hover:bg-white/10"
            }`}
          >
            {tab === "all" ? "All" : tab.charAt(0).toUpperCase() + tab.slice(1)}
            {(counts[tab] ?? 0) > 0 && (
              <span className="ml-1.5 opacity-70">{counts[tab]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
        <Input
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="glass-input pl-9 pr-8"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Applications list */}
      {filtered.length === 0 ? (
        <div className="glass-panel p-8 text-center text-muted">
          {search || activeTab !== "all" ? "No matching applications." : "No applications yet."}
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((app) => (
            <div key={app.id} className="glass-panel p-5 space-y-4">
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

              {app.admin_notes && (
                <p className="text-xs text-sage border-l-2 border-sage/30 pl-3">
                  {app.admin_notes}
                </p>
              )}

              <ApplicationActions
                applicationId={app.id}
                currentStatus={app.status}
                adminNotes={app.admin_notes}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
