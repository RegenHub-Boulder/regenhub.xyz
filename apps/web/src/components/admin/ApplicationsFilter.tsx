"use client";

import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, X } from "lucide-react";
import { ApplicationActions, relTime, type JoinApplication } from "@/components/admin/ApplicationActions";
import type { ApplicationStatus } from "@/lib/supabase/types";
import { ANSWER_WITHIN_HOURS, approverWords } from "@regenhub/shared/joining";

const statusStyle: Record<ApplicationStatus, string> = {
  pending: "border-warn/40 text-warn",
  approved: "border-ok/40 text-ok",
  rejected: "border-danger/40 text-danger",
  closed:   "border-rule text-muted",
};

const statusTabs = ["all", "pending", "approved", "rejected", "closed"] as const;

export function ApplicationsFilter({
  applications,
  names = {},
  nowMs,
  canApprove,
}: {
  applications: JoinApplication[];
  /** The page's "now" (server render): which ones are late. */
  nowMs: number;
  /** Member names by id: who they named, who vouched, who decided. */
  names?: Record<number, string>;
  /** A co-op member (lib/approval.ts canApproveOnSite): vouch, approve and turn down. Otherwise the lists only. */
  canApprove: boolean;
}) {
  const [activeTab, setActiveTab] = useState<string>("pending");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let result = applications;
    if (activeTab !== "all") {
      result = result.filter((a) => a.status === activeTab);
    }
    // Waiting: the oldest first, so the late ones lead.
    if (activeTab === "pending") result = [...result].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
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
                : "bg-tint text-muted border border-rule hover:bg-ink/10"
            }`}
          >
            {tab === "all" ? "All" : tab.charAt(0).toUpperCase() + tab.slice(1)}
            {(counts[tab] ?? 0) > 0 && (
              <span className="ml-1.5 font-normal">{counts[tab]}</span>
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
                  <span className={app.status === "pending" && nowMs - Date.parse(app.created_at) > ANSWER_WITHIN_HOURS * 3_600_000 ? "text-danger" : ""}>
                    {app.status === "pending" ? `waiting ${relTime(app.created_at).replace(" ago", "")}` : new Date(app.created_at).toLocaleDateString("en-US", {
                      timeZone: "America/Denver",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>
              </div>

              <dl className="grid sm:grid-cols-[9rem_1fr] gap-x-4 gap-y-1 text-sm">
                {app.about && (<><dt className="text-muted">Works on</dt><dd>{app.about}</dd></>)}
                {app.how_found && (<><dt className="text-muted">Found us</dt><dd>{app.how_found}</dd></>)}
                {app.why_join && (<><dt className="text-muted">Why join</dt><dd>{app.why_join}</dd></>)}
                <dt className="text-muted">Knows</dt>
                <dd>{app.known_by_member_id ? names[app.known_by_member_id] ?? "a member" : "Nobody yet"}</dd>
                <dt className="text-muted">Vouch</dt>
                <dd data-testid="vouch-line">
                  {app.vouched_by || app.vouched_by_telegram_id
                    ? <span className="text-ok">{approverWords({ name: app.vouched_by ? names[app.vouched_by] : null, telegram: app.vouched_by_telegram }) ?? "Someone in the chat"} vouched, {relTime(app.vouched_at)}</span>
                    : app.status === "pending" ? <span className="text-warn">Waiting for a member who knows them</span> : "None"}
                </dd>
              </dl>

              {app.admin_notes && (
                <p className="text-xs text-sage border-l-2 border-sage/30 pl-3">
                  {app.admin_notes}
                </p>
              )}

              <ApplicationActions application={app} names={names} canApprove={canApprove} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
