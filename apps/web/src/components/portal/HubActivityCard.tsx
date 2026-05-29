import Link from "next/link";
import { Activity, Users, DoorOpen, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface Props {
  /** Distinct members who unlocked the door in the last 6 hours (real signal). */
  hereNow: number;
  /** Day codes still active right now (proxy: guests with current access). */
  activeGuestCodes: number;
  /** Day codes issued today (proxy: volume of guest activity). */
  guestCodesToday: number;
  /** Total Full members in the system (potential population). */
  fullMembers: number;
  /** Co-op members get the "Zoom in →" link to the access log. */
  canZoomIn?: boolean;
  /** Optional: the most recent attributed entry — shown subtly to convey freshness. */
  lastEntry?: { memberName: string; whenIso: string } | null;
}

/**
 * Hub activity at a glance.
 *
 * Real-time presence comes from /api/access-events writing to access_logs
 * (wired via Home Assistant). Until that flow is hot, we surface the proxy
 * signals (day-code activity) so the card is still useful from day one.
 */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const ms = Date.now() - then;
  if (ms < 0) return "just now";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/Denver",
    month: "short",
    day: "numeric",
  });
}

export function HubActivityCard({ hereNow, activeGuestCodes, guestCodesToday, fullMembers, canZoomIn = false, lastEntry = null }: Props) {
  // Don't bother rendering on quiet days — if nothing's happening, the card
  // just adds noise to /portal.
  if (hereNow === 0 && activeGuestCodes === 0 && guestCodesToday === 0) return null;

  const hasLiveData = hereNow > 0;

  return (
    <Card className="glass-panel border border-sage/20">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-sage" />
          <h3 className="text-sm font-semibold">Hub activity</h3>
          {hasLiveData && (
            <span className="text-[10px] uppercase tracking-wider text-sage flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-sage animate-pulse" />
              live
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <p className="text-2xl font-bold text-foreground tabular-nums flex items-center gap-1">
              <DoorOpen className="w-4 h-4 text-sage" />
              {hereNow}
            </p>
            <p className="text-xs text-muted mt-0.5">here now <span className="text-[10px]">(6h)</span></p>
          </div>
          <div>
            <p className="text-2xl font-bold text-foreground tabular-nums">{activeGuestCodes}</p>
            <p className="text-xs text-muted mt-0.5">active guest code{activeGuestCodes === 1 ? "" : "s"}</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-foreground tabular-nums">{guestCodesToday}</p>
            <p className="text-xs text-muted mt-0.5">issued today</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-foreground tabular-nums">{fullMembers}</p>
            <p className="text-xs text-muted mt-0.5 flex items-center gap-1">
              <Users className="w-3 h-3" />
              Full members
            </p>
          </div>
        </div>

        {!hasLiveData && (
          <p className="text-[10px] text-muted mt-3 italic">
            Real-time presence kicks in once HA → /api/access-events is wired.
          </p>
        )}

        {(canZoomIn || lastEntry) && (
          <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between gap-3 flex-wrap">
            {lastEntry ? (
              <p className="text-xs text-muted">
                Last in: <span className="text-foreground">{lastEntry.memberName}</span>
                <span className="text-muted/70"> · {formatRelative(lastEntry.whenIso)}</span>
              </p>
            ) : (
              <span />
            )}
            {canZoomIn && (
              <Link
                href="/portal/access-log"
                className="text-xs text-sage hover:text-sage/80 flex items-center gap-1"
              >
                Zoom in <ChevronRight className="w-3 h-3" />
              </Link>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
