import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";

/**
 * POST /api/cron/sync-access-logs
 *
 * Polls Home Assistant's logbook for lock state changes since the last sync
 * and writes "door unlocked" entries to `access_logs`. Designed to be hit by
 * Coolify cron every 1-2 minutes.
 *
 * Why polling instead of HA-pushes-to-/api/access-events:
 * Pushing requires a `rest_command:` block in HA's configuration.yaml — file
 * edit we can't make remotely. Polling is cheaper to operate and good enough
 * for the "is the hub active" signal we surface on /portal.
 *
 * What this captures:
 *  - Each time a lock entity transitions to "unlocked" → one access_logs row
 *  - method = 'pin' (best guess; HA logbook doesn't expose user attribution
 *    on plain state changes)
 *  - member_id = null (we don't know WHO unlocked without zwave event data)
 *
 * What this MISSES:
 *  - Who (which member / which PIN slot) — for that, wire HA → /api/access-events
 *    per the YAML in /api/access-events/route.ts. Both can coexist.
 *
 * Idempotency: tracks "last sync" via the most recent access_logs.created_at
 * for method='pin' + result='granted'. Anything older than that we skip.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const haUrl = process.env.HA_URL?.replace(/\/$/, "");
  const haToken = process.env.HA_TOKEN;
  const lockEntitiesRaw = process.env.HA_LOCK_ENTITIES;
  if (!haUrl || !haToken || !lockEntitiesRaw) {
    return NextResponse.json(
      { error: "HA_URL / HA_TOKEN / HA_LOCK_ENTITIES required" },
      { status: 503 },
    );
  }
  const lockEntities = lockEntitiesRaw.split(",").map((s) => s.trim()).filter(Boolean);

  const admin = createServiceClient();

  // Cursor: latest access_logs row we've ingested from HA. We tag those with
  // note prefix "HA:" so we only consider our own past entries (not manual
  // /api/access-events pushes).
  const { data: cursorRow } = await admin
    .from("access_logs")
    .select("created_at")
    .like("note", "HA:%")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Default look-back if we have no prior data: 30 minutes (cron runs more often).
  const sinceMs = cursorRow?.created_at
    ? new Date(cursorRow.created_at).getTime()
    : Date.now() - 30 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();

  // HA logbook accepts the timestamp in the URL path.
  const results: { entity: string; inserted: number; errored: number }[] = [];

  for (const entity of lockEntities) {
    let inserted = 0;
    let errored = 0;
    try {
      // History API returns the actual state transitions (locked/unlocked),
      // logbook only gives us "something changed" without the state.
      const res = await fetch(
        `${haUrl}/history/period/${encodeURIComponent(since)}?filter_entity_id=${encodeURIComponent(entity)}&minimal_response=true`,
        { headers: { Authorization: `Bearer ${haToken}` } },
      );
      if (!res.ok) {
        results.push({ entity, inserted: 0, errored: 1 });
        continue;
      }
      const groups = (await res.json()) as Array<
        Array<{ state?: string; last_changed?: string }>
      >;
      const states = groups[0] ?? [];

      // Filter for "unlocked" transitions newer than our cursor. The first
      // entry in each group is the state AT `since` (carry-over), not a
      // transition — skip it via the strict > sinceMs check.
      const fresh = states.filter((s) => {
        if (s.state !== "unlocked") return false;
        if (!s.last_changed) return false;
        return new Date(s.last_changed).getTime() > sinceMs;
      });

      for (const s of fresh) {
        // Dedup: if the keypad automation already wrote an attributed entry
        // for this lock within ±60 seconds, skip — that row has slot+member
        // attribution and a real note, this would just be a duplicate.
        const when = new Date(s.last_changed!).getTime();
        const winStart = new Date(when - 60_000).toISOString();
        const winEnd = new Date(when + 60_000).toISOString();
        const { data: nearby } = await admin
          .from("access_logs")
          .select("id, note, slot")
          .gte("created_at", winStart)
          .lte("created_at", winEnd)
          .not("slot", "is", null)
          .limit(5);
        const attributedForThisLock = (nearby ?? []).some((r) => {
          const note = (r.note ?? "").toLowerCase();
          // The automation writes notes like "Yale YRL226 / Keypad unlock..."
          // or "lock.front_door_lock / ...". Match if the entity short-name
          // appears anywhere in the note.
          const short = entity.split(".").pop() ?? entity;
          return note.includes(short) || (entity.includes("front") && note.includes("front")) || (entity.includes("back") && note.includes("back"));
        });
        if (attributedForThisLock) continue;

        const { error } = await admin.from("access_logs").insert({
          method: "pin",
          slot: null,
          member_id: null,
          result: "granted",
          note: `HA:${entity}`,
          created_at: s.last_changed,
        });
        if (error) {
          console.error(`[SyncAccessLogs] insert error for ${entity} @ ${s.last_changed}:`, error);
          errored++;
        } else {
          inserted++;
        }
      }
    } catch (err) {
      console.error(`[SyncAccessLogs] fetch error for ${entity}:`, err);
      errored++;
    }
    results.push({ entity, inserted, errored });
  }

  return NextResponse.json({
    since,
    results,
    total_inserted: results.reduce((s, r) => s + r.inserted, 0),
  });
}
