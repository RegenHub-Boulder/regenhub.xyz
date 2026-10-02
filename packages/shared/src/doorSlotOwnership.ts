/**
 * Additive protocol foundation; legacy writers do not use this yet.
 * RPC reservation must commit BEFORE any device I/O. No retry/lease takeover.
 * Every dispatched command leaves the slot quarantined, including HA success.
 * Only offline, privileged recovery may release it after draining every possible
 * old sender/queue and obtaining fresh empty-slot readback from every door.
 */
export interface DoorSlotDatabase {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

export interface DoorOperation {
  slot: number;
  owner: string;
  operation: string;
  action: 'set' | 'clear';
}

export type ReservedDoorOperation = Readonly<DoorOperation & { generation: number }>;

/**
 * Dispatch is trusted device-I/O code: use only the supplied immutable context
 * for identity, send once, and do not retain/replay it after this call. This
 * wrapper cannot fence a callback that ignores the context or queues later I/O.
 */
export async function runReservedDoorOperation<T>(
  database: DoorSlotDatabase,
  operation: DoorOperation,
  dispatch: (context: ReservedDoorOperation) => Promise<T>,
): Promise<{ acknowledgement: T; generation: number; verified: false }> {
  const identity = Object.freeze({ slot: operation.slot, owner: operation.owner,
    operation: operation.operation, action: operation.action });
  const reserved = await database.rpc('door_slot_reserve', {
    p_slot: identity.slot,
    p_owner: identity.owner,
    p_operation: identity.operation,
    p_action: identity.action,
  });
  if (reserved.error) throw new Error(`Door reservation refused: ${reserved.error.message}`);
  // Fail closed on incompatible/missing migration response. Reservation remains.
  if (!Number.isSafeInteger(reserved.data) || (reserved.data as number) < 1) {
    throw new Error('Invalid door reservation generation');
  }
  const generation = reserved.data as number;
  try {
    const acknowledgement = await dispatch(Object.freeze({ ...identity, generation }));
    return { acknowledgement, generation, verified: false };
  } finally {
    // This CAS records uncertainty; it is NOT device fencing. Safety comes from
    // refusing all subsequent commands/reuse while pending or quarantined.
    // Failure here leaves pending permanently, which is equally unavailable.
    const result = await database.rpc('door_slot_quarantine', {
      p_slot: identity.slot,
      p_generation: generation,
      p_operation: identity.operation,
    });
    if (result.error) throw new Error(`Door slot remains reserved: ${result.error.message}`);
  }
}
