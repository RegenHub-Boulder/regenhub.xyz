import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity } from "lucide-react";
import { planLabel } from "@/lib/plans";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Denver", month: "short", day: "numeric", year: "numeric" });
}

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
  membership_approved:    "Approved as a member",
  membership_revoked:     "Member approval taken back",
  // Older rows, from before the one approval (072): the desk switch was called something else then.
  full_access_approved:   "Desk access turned on",
  full_access_revoked:    "Desk access turned off",
  desk_access_on:         "Desk access turned on",
  desk_access_off:        "Desk access turned off",
  desk_asked:             "Asked about a desk",
  application_vouched:    "Vouched for an application",
  member_disabled:        "Account disabled",
  member_deleted:         "Account deleted",
  passes_granted:         "Day passes granted",
  passes_adjusted:        "Day pass balance adjusted",
  credit_applied:         "Stripe credit applied",
  code_revoked:           "Door code revoked",
  checkout_link_generated: "Stripe checkout link generated",
  subscription_canceled_by_admin: "Subscription canceled by admin",
  plan_switch_scheduled:  "Member scheduled a switch off their desk",
  plan_switch_canceled:   "Pending plan switch canceled",
  plan_switch_completed:  "Plan switch took effect",
  onchain_payment_after_void: "Member reported paying a voided or expired invoice (unverified; check, then refund)",
  onchain_day_pass_purchased: "Bought a day pass with USDC",
  onchain_pass_payment_exception: "USDC day pass payment not credited (see reason; check on chain, then settle by hand)",
  techne_did_linked:      "Techne account linked (email link to the member email)",
  techne_did_unlinked:    "Techne account unlinked",
  email_sent:             "Email sent",
  payment_reminder_sent:  "Payment reminder sent",
  batch_email_sent:       "Batch email sent",
  free_day_approved:      "Free-day request approved",
  free_day_lapsed:        "Free day lapsed unused",
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
      return typeof p.amount === "number" && p.amount < 0 ? `${p.amount} day passes` : `+${p.amount ?? "?"} day passes`;
    case "membership_approved":
      return p.via === "chat" ? "From the members' chat" : p.via === "site" ? "From People → Applications" : null;
    case "batch_email_sent":
      return typeof p.subject === "string" ? p.subject : null;
    case "onchain_payment_after_void":
      return typeof p.tx_hash === "string" ? `Invoice #${String(p.invoice_id)} · tx ${p.tx_hash}` : null;
    case "onchain_day_pass_purchased":
      return `+1 day pass · $${typeof p.amount_cents === "number" ? (p.amount_cents / 100).toFixed(2) : "?"} USDC · invoice #${String(p.invoice_id)} · tx ${String(p.tx_hash)}`;
    case "onchain_pass_payment_exception":
      return `Invoice #${String(p.invoice_id)} · tx ${String(p.tx_hash)} · ${String(p.reason ?? "")}`;
    case "techne_did_linked":
      return typeof p.did === "string" ? p.did : null;
    case "techne_did_unlinked":
      return typeof p.did === "string" ? `${p.did}${p.by === "member" ? " · by the member" : ""}` : null;
    case "plan_switch_scheduled":
    case "plan_switch_canceled": {
      const plans = `${planLabel(String(p.from ?? "?"))} → ${planLabel(String(p.to ?? "?"))}`;
      const when = typeof p.effective_at === "string" ? `on ${formatDate(p.effective_at)}` : null;
      const by = p.reason === "admin_cancel" ? "superseded by an admin cancel" : null;
      return [plans, when, by].filter(Boolean).join(" · ");
    }
    case "plan_switch_completed":
      return [
        `${planLabel(String(p.from ?? "?"))} → ${planLabel(String(p.to ?? "?"))}`,
        p.rail === "onchain" ? "Crypto" : "Card",
        p.door_clear_failed
          ? "door code NOT cleared on every lock — slot quarantined, run Lock Sync"
          : typeof p.door_slot_cleared === "number" ? `desk door code cleared (slot ${p.door_slot_cleared})` : "no desk door code to clear",
      ].join(" · ");
    case "subscription_canceled_by_admin":
      if (!p.rail) return null;
      return [
        p.rail === "onchain" ? "Crypto" : "Card",
        p.mode === "period_end" ? "at period end" : "now",
        Array.isArray(p.voided_invoice_ids) && p.voided_invoice_ids.length ? `voided ${p.voided_invoice_ids.join(", ")}` : null,
        typeof p.reason === "string" ? p.reason : null,
      ].filter(Boolean).join(" · ");
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
        <ul className="divide-y divide-rule">
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
                  <Badge className="text-[10px] bg-danger/10 text-danger border-danger/40">
                    {r.action.split("_").pop()}
                  </Badge>
                ) : r.action.includes("approved") || r.action.includes("granted") || r.action.includes("applied") ? (
                  <Badge className="text-[10px] bg-ok/10 text-ok border-ok/40">
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
