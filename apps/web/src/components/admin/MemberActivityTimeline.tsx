import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity } from "lucide-react";

interface ActionRow {
  id: number;
  action: string;
  actor_name: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

interface Props {
  rows: ActionRow[];
}

/** Map raw action verbs to human-readable labels. Falls back to the raw string. */
const ACTION_LABELS: Record<string, string> = {
  membership_approved:    "Approved for Daily membership",
  membership_revoked:     "Daily approval revoked",
  full_access_approved:   "Approved for Full Access",
  full_access_revoked:    "Full Access approval revoked",
  member_disabled:        "Account disabled",
  member_deleted:         "Account deleted",
  passes_granted:         "Day passes granted",
  passes_adjusted:        "Day pass balance adjusted",
  credit_applied:         "Stripe credit applied",
  code_revoked:           "Door code revoked",
  checkout_link_generated: "Stripe checkout link generated",
  subscription_canceled_by_admin: "Subscription canceled by admin",
  email_sent:             "Email sent",
  batch_email_sent:       "Batch email sent",
  free_day_approved:      "Free-day claim approved",
  application_approved:   "Application approved",
};

/** Pick the most useful payload fields to surface inline per action type. */
function summary(row: ActionRow): string | null {
  const p = row.payload ?? {};
  switch (row.action) {
    case "credit_applied":
      return `$${typeof p.dollars === "number" ? p.dollars.toFixed(2) : "?"} — ${p.note ?? ""}`;
    case "passes_granted":
    case "passes_adjusted":
      return `+${p.amount ?? "?"} day passes`;
    case "membership_approved":
    case "full_access_approved":
      return p.implies_membership ? "Implies Daily approval" : null;
    case "batch_email_sent":
      return typeof p.subject === "string" ? p.subject : null;
    default:
      return null;
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Denver",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MemberActivityTimeline({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <Card className="glass-panel">
        <CardContent className="p-8 text-center">
          <Activity className="w-8 h-8 text-muted mx-auto mb-3" />
          <p className="text-sm text-muted">No admin actions recorded for this member yet.</p>
          <p className="text-xs text-muted mt-1 italic">
            Future approvals, credits, and admin changes will appear here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass-panel">
      <CardContent className="p-0">
        <ul className="divide-y divide-white/5">
          {rows.map((r) => {
            const label = ACTION_LABELS[r.action] ?? r.action;
            const detail = summary(r);
            return (
              <li key={r.id} className="px-5 py-3 flex items-start gap-3">
                <div className="w-20 shrink-0 text-xs text-muted tabular-nums mt-0.5">
                  {formatTime(r.created_at)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm">
                    {label}
                    {r.actor_name && (
                      <span className="text-xs text-muted ml-1.5">by {r.actor_name}</span>
                    )}
                  </p>
                  {detail && (
                    <p className="text-xs text-muted truncate mt-0.5">{detail}</p>
                  )}
                </div>
                {r.action.includes("revoked") || r.action.includes("disabled") || r.action.includes("deleted") ? (
                  <Badge className="text-[10px] bg-red-500/15 text-red-400 border-red-500/25">
                    {r.action.split("_").pop()}
                  </Badge>
                ) : r.action.includes("approved") || r.action.includes("granted") || r.action.includes("applied") ? (
                  <Badge className="text-[10px] bg-emerald-500/15 text-emerald-400 border-emerald-500/25">
                    {r.action.split("_").pop()}
                  </Badge>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
