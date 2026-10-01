/**
 * In-flight multi-step flows (`/newcode`, `/quickcode`, the `/admin` menu).
 *
 * The store is keyed by chat, because that is the conversation the prompt was
 * sent to — but in a group chat every member can reply into that same
 * conversation. Each entry therefore also records the Telegram user id of the
 * person who started the flow, and a follow-up is only accepted from them.
 * Everyone else's messages and button taps fall through as if no flow were
 * open.
 */

export type PendingActionType =
  | "newcode"
  | "quickcode"
  | "addmember"
  | "addpasses"
  | "addadmin"
  | "changetype";

export type PendingAction = {
  type: PendingActionType;
  step: string;
  data: Record<string, unknown>;
  timestamp: number;
  /** Telegram user id of whoever started this flow. Only they may continue it. */
  ownerId: number;
};

const pending = new Map<number, PendingAction>();

/** Open (or advance) a flow in `chatId`, owned by `action.ownerId`. */
export function setPending(chatId: number, action: PendingAction): void {
  pending.set(chatId, action);
}

/**
 * The flow open in `chatId`, but only if `userId` is the person who started
 * it. Returns null for "no flow" and for "somebody else's flow" alike —
 * callers must not be able to tell the difference.
 */
export function getPending(chatId: number, userId: number | undefined): PendingAction | null {
  const action = pending.get(chatId);
  if (!action) return null;
  if (userId === undefined || action.ownerId !== userId) return null;
  return action;
}

export function clearPending(chatId: number): void {
  pending.delete(chatId);
}

/** Test helper — drops every flow so cases don't leak into each other. */
export function resetPending(): void {
  pending.clear();
}
