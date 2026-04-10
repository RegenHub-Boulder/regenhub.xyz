"use client";

import { useState, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Search, X } from "lucide-react";
import { ClaimActions } from "@/components/admin/ClaimActions";

type FreeDayClaim = {
  id: number;
  email: string;
  name: string;
  claimed_date: string;
  status: string;
  created_at: string;
  about?: string | null;
  why_join?: string | null;
  invite_code?: string | null;
};

const statusTabs = ["all", "pending", "reserved", "activated", "expired", "cancelled"] as const;

const statusStyle: Record<string, string> = {
  pending: "border-amber-400/50 text-amber-400",
  reserved: "border-blue-400/50 text-blue-400",
  activated: "border-emerald-400/50 text-emerald-400",
  expired: "border-muted text-muted",
  cancelled: "border-red-400/50 text-red-400",
};

export function ClaimsFilter({ claims }: { claims: FreeDayClaim[] }) {
  const [activeTab, setActiveTab] = useState<string>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let result = claims;
    if (activeTab !== "all") {
      result = result.filter((c) => c.status === activeTab);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q)
      );
    }
    return result;
  }, [claims, activeTab, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: claims.length };
    for (const claim of claims) {
      c[claim.status] = (c[claim.status] ?? 0) + 1;
    }
    return c;
  }, [claims]);

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

      {/* Claims list */}
      {filtered.length === 0 ? (
        <div className="glass-panel p-8 text-center text-muted">
          {search || activeTab !== "all" ? "No matching claims." : "No free day claims yet."}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((claim) => (
            <div key={claim.id} className="glass-panel p-5 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <h3 className="font-semibold">{claim.name}</h3>
                  <Badge variant="outline" className={`text-xs ${statusStyle[claim.status] ?? ""}`}>
                    {claim.status}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted">
                  <span>{claim.email}</span>
                  <span>
                    {new Date(claim.claimed_date + "T12:00:00").toLocaleDateString("en-US", {
                      month: "short", day: "numeric", weekday: "short",
                    })}
                  </span>
                  <span>
                    Applied {new Date(claim.created_at).toLocaleDateString("en-US", {
                      month: "short", day: "numeric",
                    })}
                  </span>
                </div>
              </div>

              {(claim.about || claim.why_join) && (
                <div className="grid sm:grid-cols-2 gap-4">
                  {claim.about && (
                    <div>
                      <p className="text-xs text-muted mb-1 font-medium">What are you working on?</p>
                      <p className="text-sm text-foreground/80">{claim.about}</p>
                    </div>
                  )}
                  {claim.why_join && (
                    <div>
                      <p className="text-xs text-muted mb-1 font-medium">Why do you want to visit?</p>
                      <p className="text-sm text-foreground/80">{claim.why_join}</p>
                    </div>
                  )}
                </div>
              )}

              <ClaimActions claimId={claim.id} currentStatus={claim.status} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
