/**
 * Telegram identity decision, kept pure so it is unit-testable.
 *
 * Inputs: the sender's numeric id (stable) and the member row matched by
 * @username (mutable, recyclable). Output says whether the row is this person.
 */
export type IdentityDecision =
  | { action: "accept" } // already bound to this id
  | { action: "bind" } // unbound row; bind on first verified interaction
  | { action: "refuse"; reason: "id_mismatch" | "no_sender_id" };

export function decideIdentity(
  row: { telegram_user_id?: number | string | null },
  senderId: number | undefined,
): IdentityDecision {
  if (senderId === undefined || senderId === null) return { action: "refuse", reason: "no_sender_id" };
  const bound = row.telegram_user_id;
  if (bound === null || bound === undefined) return { action: "bind" };
  // bigint columns can come back as strings through PostgREST.
  return String(bound) === String(senderId) ? { action: "accept" } : { action: "refuse", reason: "id_mismatch" };
}
