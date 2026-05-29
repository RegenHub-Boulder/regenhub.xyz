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

  // Try to resolve via PIN slot if the caller didn't give us a member id.
  if (!memberId && typeof body.slot === "number") {
    // Members (permanent slots 1-100)
    const { data: memberHit } = await admin
      .from("members")
      .select("id")
      .eq("pin_code_slot", body.slot)
      .maybeSingle();
    if (memberHit) {
      memberId = memberHit.id;
    } else {
      // Day codes (slots 101-200)
      const { data: dayHit } = await admin
        .from("day_codes")
        .select("member_id")
        .eq("pin_slot", body.slot)
        .eq("is_active", true)
        .order("issued_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (dayHit?.member_id) memberId = dayHit.member_id;
    }
  }

  const { error } = await admin.from("access_logs").insert({
    method: body.method,
    slot: body.slot ?? null,
    member_id: memberId,
    result: body.result ?? "granted",
    note: body.note ?? null,
  });

  if (error) {
    console.error("[AccessEvents] insert error:", error);
    return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, attributed: memberId != null });
}
