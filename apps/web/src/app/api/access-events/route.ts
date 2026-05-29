import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

type AccessMethod = Database["public"]["Enums"]["access_method"];

/**
 * POST /api/access-events
 *
 * Receives door-entry events from Home Assistant (or any other lock
 * integration) and writes them to `access_logs`. Auth: shared secret in
 * the `Authorization: Bearer …` header (HA_WEBHOOK_SECRET env var).
 *
 * Body shape:
 *   {
 *     method: "pin" | "manual" | "remote",  // matches access_method enum
 *     slot?: number,                         // PIN slot if known (preferred)
 *     pin_code?: string,                     // raw PIN for lookup if no slot
 *     member_id?: number,                    // explicit, if HA can resolve
 *     result?: "granted" | "denied",         // defaults to granted
 *     note?: string,                         // free-form ("front door", etc)
 *   }
 *
 * HA setup (sketch):
 *   automation:
 *     - alias: "RegenHub lock used → log"
 *       trigger:
 *         - platform: event
 *           event_type: zwave_js_notification
 *       condition: "{{ trigger.event.data.event == 'KEYPAD_UNLOCK' }}"
 *       action:
 *         - service: rest_command.regenhub_log_entry
 *           data:
 *             slot: "{{ trigger.event.data.userid }}"
 *             method: "pin"
 *             result: "granted"
 *             note: "{{ trigger.event.data.entity_id }}"
 *
 * Member resolution priority:
 *   1. body.member_id (admin sent it)
 *   2. members.pin_code_slot = body.slot
 *   3. day_codes (is_active=true, pin_slot=body.slot) → member_id
 *   4. null (still logged, but unattributed)
 */
export async function POST(req: Request) {
  const secret = process.env.HA_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "HA_WEBHOOK_SECRET is not configured on this environment" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    method?: AccessMethod;
    slot?: number;
    pin_code?: string;
    member_id?: number;
    result?: "granted" | "denied";
    note?: string;
  } | null;

  if (!body?.method) {
    return NextResponse.json({ error: "method required" }, { status: 400 });
  }

  const admin = createServiceClient();
  let memberId = body.member_id ?? null;
  let dayCodeLabel: string | null = null;

  // Try to resolve via PIN slot if the caller didn't give us a member id.
  if (!memberId && typeof body.slot === "number" && body.slot > 0) {
    // Members (permanent slots 1-100)
    const { data: memberHit } = await admin
      .from("members")
      .select("id")
      .eq("pin_code_slot", body.slot)
      .maybeSingle();
    if (memberHit) {
      memberId = memberHit.id;
    } else if (body.slot >= 101 && body.slot <= 200) {
      // Day codes (slots 101-200). First try active; fall back to the most
      // recent code at that slot regardless of is_active, because the lock
      // might fire the unlock event a moment after the code expired (or for
      // free-day visitors who don't have a linked member, the label still
      // tells us who they are).
      let { data: dayHit } = await admin
        .from("day_codes")
        .select("member_id, label")
        .eq("pin_slot", body.slot)
        .eq("is_active", true)
        .order("issued_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!dayHit) {
        const fallback = await admin
          .from("day_codes")
          .select("member_id, label")
          .eq("pin_slot", body.slot)
          .order("issued_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        dayHit = fallback.data;
      }
      if (dayHit?.member_id) memberId = dayHit.member_id;
      if (dayHit?.label) dayCodeLabel = dayHit.label;
    }
  }

  // Compose the final note. Append the day-code label (e.g. "Free Day: Austen Henry")
  // when we have one but no member_id — gives the access log a name to show.
  const finalNote = dayCodeLabel && !memberId
    ? `${body.note ?? ""} · ${dayCodeLabel}`.trim()
    : body.note ?? null;

  const { error } = await admin.from("access_logs").insert({
    method: body.method,
    slot: body.slot ?? null,
    member_id: memberId,
    result: body.result ?? "granted",
    note: finalNote,
  });

  // Dedup: if this is an attributed entry, delete any anonymous polling-cron
  // entries for the same lock that landed within the last 5 seconds — they're
  // the same physical unlock, just caught by the dumber writer first.
  if (!error && (memberId || (body.slot && body.slot > 0)) && body.note) {
    const lockHint = body.note.toLowerCase().match(/(lock\.[a-z_]+)/)?.[1];
    if (lockHint) {
      const cutoff = new Date(Date.now() - 5_000).toISOString();
      await admin
        .from("access_logs")
        .delete()
        .like("note", `HA:%${lockHint}%`)
        .is("member_id", null)
        .is("slot", null)
        .gte("created_at", cutoff);
    }
  }

  if (error) {
    console.error("[AccessEvents] insert error:", error);
    return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, attributed: memberId != null });
}
