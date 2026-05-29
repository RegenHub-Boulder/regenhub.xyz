import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DoorOpen, ChevronLeft, AlertCircle, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Access Log — RegenHub" };

interface AccessLogRow {
  id: number;
  created_at: string;
  method: string;
  slot: number | null;
  result: string;
  note: string | null;
  member_id: number | null;
}

interface MemberShort {
  id: number;
  name: string;
  profile_photo_url: string | null;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/Denver",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDay(iso: string, todayMs: number): string {
  const d = new Date(iso);
  const today = new Date(todayMs);
  const yest = new Date(todayMs - 24 * 60 * 60 * 1000);
  const dStr = d.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  const todayStr = today.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  const yestStr = yest.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  if (dStr === todayStr) return "Today";
  if (dStr === yestStr) return "Yesterday";
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Denver",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Try to derive a friendly lock label from the `note` field.
 *
 * The note can come in several shapes depending on which writer captured it:
 *  - "HA:lock.front_door_lock"               (polling cron — entity_id)
 *  - "lock.front_door_lock / Keypad unlock"  (older automation w/ entity_id)
 *  - "Yale YRL226 / Keypad unlock"           (newer automation w/ device name)
 *  - "node_2 / Keypad unlock"                (fallback to node_id)
 *  - "Roundtrip test from API"               (manual)
 */
function lockLabel(note: string | null): string {
  if (!note) return "Unknown lock";
  const n = note.toLowerCase();
  if (n.includes("front") || n.includes("yrl226") || n.includes("yrl256") || n.includes("node_2")) return "Front door";
  if (n.includes("back") || n.includes("yrd410") || n.includes("yrd420") || n.includes("node_3")) return "Back door";
  return note.split(" / ")[0] ?? note;
}

/** What kind of entry: attributed / guest day code / anonymous polling */
function entryKind(row: AccessLogRow): "attributed" | "guest" | "polling" | "denied" {
  if (row.result === "denied") return "denied";
  if (row.member_id) return "attributed";
  if (row.slot && row.slot >= 101 && row.slot <= 200) return "guest";
  return "polling";
}

export default async function AccessLogPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: member } = await supabase
    .from("members")
    .select("id, is_coop_member, is_admin")
    .eq("supabase_user_id", user.id)
    .maybeSingle();

  // Gate: co-op members + admins only. Everyone else gets a friendly 403-ish.
  if (!member?.is_coop_member && !member?.is_admin) {
    return (
      <div className="glass-panel p-8 text-center max-w-md mx-auto mt-8">
        <AlertCircle className="w-8 h-8 text-muted mx-auto mb-3" />
        <h2 className="font-semibold mb-2">Access log is co-op-only</h2>
        <p className="text-sm text-muted mb-5">
          The hub access log is visible to co-op members. If you&apos;re interested in
          becoming a co-op member, reach out!
        </p>
        <Link href="/portal">
          <Button className="btn-glass gap-1">
            <ChevronLeft className="w-4 h-4" />
            Back to portal
          </Button>
        </Link>
      </div>
    );
  }

  // Service client because RLS only lets a member see their own log row.
  // We've already gated at the app level (is_coop_member or is_admin).
  const admin = createServiceClient();
  /* eslint-disable react-hooks/purity -- server component, renders once per request */
  const nowMs = Date.now();
  const since = new Date(nowMs - 14 * 24 * 60 * 60 * 1000).toISOString();
  /* eslint-enable react-hooks/purity */
  const { data: rows } = await admin
    .from("access_logs")
    .select("id, created_at, method, slot, result, note, member_id")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<AccessLogRow[]>();

  // Resolve members in one query rather than N+1.
  const memberIds = Array.from(
    new Set((rows ?? []).map((r) => r.member_id).filter((id): id is number => id != null)),
  );
  const memberMap = new Map<number, MemberShort>();
  if (memberIds.length > 0) {
    const { data: members } = await admin
      .from("members")
      .select("id, name, profile_photo_url")
      .in("id", memberIds)
      .returns<MemberShort[]>();
    for (const m of members ?? []) memberMap.set(m.id, m);
  }

  // Group by day for the timeline.
  const groups = new Map<string, AccessLogRow[]>();
  for (const r of rows ?? []) {
    const day = formatDay(r.created_at, nowMs);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(r);
  }

  const totalCount = rows?.length ?? 0;
  const attributedCount = (rows ?? []).filter((r) => r.member_id).length;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Link href="/portal">
          <Button variant="ghost" size="sm" className="gap-1 text-muted">
            <ChevronLeft className="w-4 h-4" /> Portal
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-forest">Hub access log</h1>
          <p className="text-xs text-muted mt-0.5">
            Last 14 days · {totalCount} entries · {attributedCount} attributed to members
            {" "}· co-op visibility only
          </p>
        </div>
      </div>

      {groups.size === 0 ? (
        <Card className="glass-panel">
          <CardContent className="p-8 text-center">
            <DoorOpen className="w-8 h-8 text-muted mx-auto mb-3" />
            <p className="text-sm text-muted">No entries yet in the last 14 days.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {Array.from(groups.entries()).map(([day, dayRows]) => (
            <section key={day} className="space-y-2">
              <h2 className="text-xs uppercase tracking-wider text-muted font-medium pl-1">
                {day} <span className="text-muted/60">· {dayRows.length}</span>
              </h2>
              <Card className="glass-panel">
                <CardContent className="p-0">
                  <ul className="divide-y divide-white/5">
                    {dayRows.map((r) => {
                      const kind = entryKind(r);
                      const m = r.member_id ? memberMap.get(r.member_id) : null;
                      return (
                        <li
                          key={r.id}
                          className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02] transition-colors"
                        >
                          <div className="w-14 text-xs tabular-nums text-muted shrink-0">
                            {formatTime(r.created_at)}
                          </div>
                          {m?.profile_photo_url ? (
                            // eslint-disable-next-line @next/next/no-img-element -- arbitrary URL
                            <img
                              src={m.profile_photo_url}
                              alt={m.name}
                              className="w-7 h-7 rounded-full object-cover border border-white/10 shrink-0"
                            />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-sage/15 border border-white/10 shrink-0 flex items-center justify-center">
                              <UserRound className="w-3.5 h-3.5 text-muted" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-foreground truncate">
                              {m ? m.name : kind === "guest" ? "Guest day code" : kind === "denied" ? "Denied entry" : "Unattributed"}
                            </p>
                            <p className="text-xs text-muted truncate">
                              {lockLabel(r.note)}
                              {r.slot != null && (
                                <span className="ml-1 text-muted/60">· slot {r.slot}</span>
                              )}
                            </p>
                          </div>
                          {kind === "denied" && (
                            <Badge className="text-[10px] bg-red-500/20 text-red-400 border-red-500/30">
                              denied
                            </Badge>
                          )}
                          {kind === "guest" && (
                            <Badge className="text-[10px] bg-gold/15 text-gold border-gold/30">
                              guest
                            </Badge>
                          )}
                          {kind === "polling" && (
                            <Badge className="text-[10px] bg-white/10 text-muted border-white/15">
                              no slot
                            </Badge>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            </section>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted italic">
        Polling cron writes &quot;no slot&quot; rows from HA history every 2 minutes; the keypad
        automation writes attributed rows in real time. If you see a {`"`}denied{`"`} entry,
        someone tried a code that didn&apos;t match a programmed slot.
      </p>
    </div>
  );
}
