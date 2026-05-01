/**
 * Atomic PIN-slot allocation via INSERT-with-retry.
 *
 * The naive find-then-insert pattern races: two concurrent requests can both
 * read the same "available" slot and both INSERT into it. With a partial
 * unique index on the slot column (see migration 018), one INSERT wins and
 * the other gets a Postgres `23505` unique-violation. This helper catches
 * that, picks the next free slot, and retries.
 *
 * Without the migration, the `23505` path is unreachable and behavior
 * silently degrades to current find-then-insert (still vulnerable). Apply
 * the migration to make it airtight.
 */

const PG_UNIQUE_VIOLATION = "23505";

type AllocateResult<T> =
  | { ok: true; data: T; slot: number }
  | { ok: false; error: string; exhausted?: boolean };

interface AllocateOpts<T> {
  min: number;
  max: number;
  /** Returns the set of slot numbers currently in use. Re-called on each retry. */
  getUsedSlots: () => Promise<Set<number>>;
  /**
   * Attempts the INSERT with the chosen slot. Must surface a Postgres-style
   * `{ code }` field on the error so the helper can detect collisions.
   * `PromiseLike` rather than `Promise` so Supabase's PostgrestBuilder
   * (thenable but not a real Promise) works without an extra `await`.
   */
  tryInsert: (slot: number) => PromiseLike<{
    data: T | null;
    error: { code?: string; message: string } | null;
  }>;
  maxRetries?: number;
}

export async function allocateSlotWithRetry<T extends object>(opts: AllocateOpts<T>): Promise<AllocateResult<T>> {
  const maxRetries = opts.maxRetries ?? 5;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const used = await opts.getUsedSlots();

    let chosen: number | null = null;
    for (let s = opts.min; s <= opts.max; s++) {
      if (!used.has(s)) {
        chosen = s;
        break;
      }
    }
    if (chosen === null) {
      return { ok: false, error: "All slots in use", exhausted: true };
    }

    const result = await opts.tryInsert(chosen);
    if (!result.error && result.data) {
      return { ok: true, data: result.data, slot: chosen };
    }

    if (result.error?.code === PG_UNIQUE_VIOLATION) {
      // Another request claimed this slot first — retry with a fresh used-set.
      continue;
    }

    return { ok: false, error: result.error?.message ?? "Insert failed" };
  }

  return { ok: false, error: "Could not allocate slot after multiple retries" };
}
