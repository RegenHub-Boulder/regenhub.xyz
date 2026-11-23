import { DAY_CODE_SLOT_MAX, DAY_CODE_SLOT_MIN, MEMBER_SLOT_MAX, MEMBER_SLOT_MIN } from "@regenhub/shared";

/**
 * Door → Lock Sync explains each quarantined slot in plain words (T-482 round 3). A slot is quarantined when a write
 * to the locks didn't finish cleanly (packages/shared/src/lockSlotSafety.ts, homeAssistant.ts `setUserCode`), so a
 * code may still sit on a lock; nothing is allocated there until a clear is confirmed by every lock. Pure, so the
 * copy is tested from rows.
 */

export interface QuarantineRow {
  slot: number;
  reason: string;
  quarantined_at: string;
  door_results?: unknown;
}

/** Who holds the slot now, if anyone (a member's own code, or a live guest code). */
export type SlotHolder = { kind: "member"; name: string } | { kind: "guest"; label: string | null } | null;

export interface QuarantineExplained {
  slot: number;
  /** "Guest-code slot 101" / "Member slot 12". */
  title: string;
  since: string;
  /** Why it's here, in plain words. */
  why: string;
  /** What each lock said on the last attempt, when it was recorded ("Front door: no answer"). */
  doors: string[];
  /** What Clear will do for this slot, given who holds it. */
  clearing: string;
  /** The stored reason, kept for anyone debugging; shown small. */
  raw: string;
}

export const CLEAR_EXPLAINED =
  "Clear sends “remove the code in this slot” to every lock. The slot is released only if every lock confirms; " +
  "if any lock doesn't answer, it stays here and you can try again later.";

const WHY: { match: RegExp; why: string }[] = [
  { match: /^SET threw or timed out/i,
    why: "Setting a door code here failed: no lock confirmed it, or the request timed out. A lock may still have the code, so it isn't reused." },
  { match: /^SET incomplete/i,
    why: "A door code was set here, but at least one lock didn't confirm it (it didn't answer, or reported low battery or offline). It isn't reused until every lock is wiped." },
  { match: /^SET in progress or interrupted/i,
    why: "A door code was being set here when the request stopped part-way, so a lock may hold half of it." },
  { match: /^Clear in progress or interrupted/i,
    why: "A clear was running here when the request stopped part-way." },
  { match: /^Clear not confirmed on every configured door/i,
    why: "The last clear didn't get a yes from every lock." },
  { match: /^Ownership released without confirmed all-door clear/i,
    why: "The code here was revoked, expired or moved without every lock confirming it was wiped." },
  { match: /^Clear had a failed or timed-out attempt/i,
    why: "The last clear had an attempt that failed or timed out on a lock, so it can't be called done." },
];

export function slotKind(slot: number): string {
  if (slot >= DAY_CODE_SLOT_MIN && slot <= DAY_CODE_SLOT_MAX) return "Guest-code slot";
  if (slot >= MEMBER_SLOT_MIN && slot <= MEMBER_SLOT_MAX) return "Member slot";
  return "Slot";
}

const doorName = (entity: string) => entity.replace(/^lock\./, "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function doorLines(results: unknown): string[] {
  if (!Array.isArray(results)) return [];
  return results.flatMap((r) => {
    if (!r || typeof r !== "object" || typeof (r as { entity?: unknown }).entity !== "string") return [];
    const { entity, ok, warning } = r as { entity: string; ok?: boolean; warning?: string };
    return [`${doorName(entity)}: ${!ok ? "didn't confirm" : warning ? `answered, but ${warning.replace(/ — .*$/, "")}` : "confirmed"}`];
  });
}

export function explainQuarantine(row: QuarantineRow, holder: SlotHolder, fmt: (iso: string) => string): QuarantineExplained {
  const why = WHY.find((w) => w.match.test(row.reason))?.why ?? "The last write to the locks for this slot didn't finish cleanly.";
  const clearing = holder?.kind === "member"
    ? `${holder.name} holds this slot. Clearing wipes their code from every lock and takes the slot off them; they'll need a new code.`
    : holder?.kind === "guest"
      ? `A live guest code${holder.label ? ` (${holder.label})` : ""} holds this slot. Clearing wipes it from every lock and ends that code.`
      : "Nobody holds this slot now. Clearing only wipes the locks, then frees the slot for the next code.";
  return {
    slot: row.slot,
    title: `${slotKind(row.slot)} ${row.slot}`,
    since: fmt(row.quarantined_at),
    why,
    doors: doorLines(row.door_results),
    clearing,
    raw: row.reason,
  };
}
