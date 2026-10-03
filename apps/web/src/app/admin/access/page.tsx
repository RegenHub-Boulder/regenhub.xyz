import { createServiceClient } from "@/lib/supabase/admin";
import { QuarantinedSlots, type QuarantinedSlot } from "@/components/admin/QuarantinedSlots";
import { createClient } from "@/lib/supabase/server";
import { AdminTabs, type TabDef } from "@/components/admin/AdminTabs";
import { LiveCodesSection, type CodeWithMember } from "@/components/admin/LiveCodesSection";
import { LockSyncSection, type LastRun } from "@/components/admin/LockSyncSection";

export const metadata = { title: "Access — Admin" };

type AccessTab = "codes" | "sync";

const TABS: TabDef<AccessTab>[] = [
  { key: "codes", label: "Live Codes" },
  { key: "sync",  label: "Lock Sync" },
];

export default async function AccessPage() {
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: quarantine, error: quarantineError } = await service.from("lock_slot_quarantine")
    .select("slot, reason, quarantined_at").order("slot");
  if (quarantineError) throw quarantineError;
  const { data: writer, error: writerError } = await service.from("lock_slot_writer")
    .select("acquired_at, holder_label").eq("id", 1).maybeSingle();
  if (writerError) throw writerError;

  // Capture a server-side `now` for "expiring soon" + "ago" calculations.
  // eslint-disable-next-line react-hooks/purity -- server component, renders once per request
  const nowMs = Date.now();
  const since = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: codes },
    { data: codesMembers },
    { count: recentInactiveCount },
    { data: slotMembers },
    { data: lastRun },
  ] = await Promise.all([
    supabase
      .from("day_codes")
      .select("*, members(name, telegram_username)")
      .eq("is_active", true)
      .order("expires_at", { ascending: true })
      .returns<CodeWithMember[]>(),
    supabase
      .from("members")
      .select("id, name")
      .eq("disabled", false)
      .order("name", { ascending: true }),
    supabase
      .from("day_codes")
      .select("*", { count: "exact", head: true })
      .eq("is_active", false)
      .gte("created_at", since),
    supabase
      .from("members")
      .select("id, name, pin_code_slot, pin_code, disabled, member_type")
      .not("pin_code_slot", "is", null)
      .order("pin_code_slot", { ascending: true }),
    supabase
      .from("lock_sync_runs")
      .select("id, synced, failed, partial, results, created_at, triggered_by, members:triggered_by(name)")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const codeRows = codes ?? [];
  const memberOptions = codesMembers ?? [];
  const slotRows = slotMembers ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-forest">Access</h1>
          <p className="text-muted text-sm mt-1">
            Door codes + lock sync — everything door-and-key related.
          </p>
        </div>
        <p className="text-sm text-muted">{codeRows.length} active codes</p>
      </div>

      <AdminTabs<AccessTab> tabs={TABS}>
        {{
          codes: (
            <LiveCodesSection
              codes={codeRows}
              members={memberOptions}
              recentInactiveCount={recentInactiveCount ?? 0}
              nowMs={nowMs}
            />
          ),
          sync: (
            <div className="space-y-6">
              {writer && (
                <div className={`text-sm ${nowMs - Date.parse(writer.acquired_at) > 120_000 ? "text-red-600" : "text-amber-500"}`}>
                  <p>Door-code writer held by {writer.holder_label} for {Math.max(0, Math.floor((nowMs - Date.parse(writer.acquired_at)) / 1000))} seconds (since {writer.acquired_at}).</p>
                  {nowMs - Date.parse(writer.acquired_at) > 120_000 && <p role="alert">Warning: reservation held for over 2 minutes; operator attention required.</p>}
                  <p>See “Stuck reservation recovery” under “Door-code writer reservation” in DEPLOYMENT.md.</p>
                </div>
              )}
              <QuarantinedSlots slots={(quarantine ?? []) as QuarantinedSlot[]} />
              <LockSyncSection
                members={slotRows}
                lastRun={(lastRun as LastRun | null) ?? null}
                nowMs={nowMs}
              />
            </div>
          ),
        }}
      </AdminTabs>
    </div>
  );
}
