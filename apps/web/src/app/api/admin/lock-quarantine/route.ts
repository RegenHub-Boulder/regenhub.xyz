import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { lockWriterErrorMessage } from "@/lib/lockWriter";
import type { ClearLine, ClearOutcome } from "@/lib/lockQuarantine";
import { assertLockWriter, clearUserCode, quarantinedSlots, recordLockWriterFailure, withLockWriter, LockWriterBusyError } from "@regenhub/shared";

type Admin = ReturnType<typeof createServiceClient>;

const MAX_SLOTS = 200;

/** Clear one quarantined slot on every lock, then take it off whoever held it. Runs inside the writer scope. */
async function clearQuarantinedSlot(admin: Admin, slot: number): Promise<ClearOutcome> {
  if (!(await quarantinedSlots()).has(slot)) return { slot, ok: true, message: "already out of quarantine" };
  // Snapshot the owner under the reservation; guard again before each HA write.
  const [{ data: member, error: memberRead }, { data: codes, error: codeRead }] = await Promise.all([
    admin.from("members").select("id").eq("pin_code_slot", slot).maybeSingle(),
    admin.from("day_codes").select("id").eq("pin_slot", slot).eq("is_active", true),
  ]);
  if (memberRead || codeRead) throw memberRead ?? codeRead;
  try { await clearUserCode(slot); }
  catch {
    return { slot, ok: false, message: "a lock didn't confirm the clear; the slot stays in quarantine" };
  }
  if (member) {
    const { error } = await admin.from("members").update({ pin_code_slot: null, pin_code: null })
      .eq("id", member.id).eq("pin_code_slot", slot);
    if (error) throw error;
  }
  for (const code of codes ?? []) {
    const { error } = await admin.from("day_codes").update({ is_active: false, revoked_at: new Date().toISOString() })
      .eq("id", code.id).eq("pin_slot", slot).eq("is_active", true);
    if (error) throw error;
  }
  return { slot, ok: true, message: "cleared on every lock and released" };
}

/**
 * Door → Lock Sync's Clear (one slot, an entry, or all): POST `{ slots: number[] }` (or `{ slot }`). Every slot runs
 * one at a time inside ONE door-code writer scope, so a batch never competes with itself for the writer, and each
 * slot's outcome is streamed as it finishes (NDJSON) so a long batch neither times out at the tunnel nor leaves the
 * admin looking at a spinner. A slot that fails stays quarantined and the batch carries on with the next.
 */
export async function POST(request: Request) {
  if (!await requireAdmin()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const raw: unknown[] = Array.isArray(body?.slots) ? body.slots : [body?.slot];
  const slots = [...new Set(raw)];
  if (!slots.length || slots.length > MAX_SLOTS || !slots.every((s) => Number.isInteger(s) && (s as number) >= 1 && (s as number) <= 200)) {
    return NextResponse.json({ error: "Invalid slot" }, { status: 400 });
  }
  const admin = createServiceClient();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The admin may close the page mid-batch: the clears still finish under the writer, only the lines go nowhere.
      const send = (line: ClearLine) => {
        try { controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)); } catch { /* reader gone */ }
      };
      try {
        await withLockWriter(admin, async () => {
          for (const [i, slot] of (slots as number[]).entries()) {
            // A batch that lost the writer (taken over after a long stall) stops: every later slot would fail the same way.
            try { await assertLockWriter(); }
            catch (error) {
              console.error("[LockQuarantine] writer lost mid-batch:", error);
              await recordLockWriterFailure(admin, "Web PIN writer", error);
              for (const rest of (slots as number[]).slice(i)) {
                send({ slot: rest, ok: false, message: "not tried: the door-code writer was lost part-way. Try again in a minute." });
              }
              break;
            }
            try { send(await clearQuarantinedSlot(admin, slot)); }
            catch (error) {
              console.error(`[LockQuarantine] slot ${slot} failed:`, error);
              await recordLockWriterFailure(admin, "Web PIN writer", error);
              send({ slot, ok: false, message: "the clear didn't finish; the slot stays in quarantine. Try again in a minute." });
            }
          }
        }, "Web PIN writer");
        send({ done: true });
      } catch (error) {
        console.error("[LockQuarantine] batch failed:", error);
        if (!(error instanceof LockWriterBusyError)) await recordLockWriterFailure(admin, "Web PIN writer", error);
        send({ error: lockWriterErrorMessage(error) });
      } finally {
        try { controller.close(); } catch { /* reader gone */ }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
