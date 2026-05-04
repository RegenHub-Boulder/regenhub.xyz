import { vi } from "vitest";

/**
 * Tiny Supabase client mock for route-handler tests.
 *
 * Why so manual: the real `@supabase/ssr` client is a chained query builder
 * (`.from(t).select(...).eq(...).single()`) that PostgREST resolves against
 * a live database. Tests don't have a database, so we hand-roll a minimum
 * surface that returns canned responses keyed by table.
 *
 * Usage:
 *   const sb = makeSupabaseMock({
 *     auth: { user: { id: "user-1", email: "a@b.c" } },
 *     selects: {
 *       members: { data: { id: 7, pin_code_slot: 12, member_type: "cold_desk", disabled: false } },
 *     },
 *     mutations: { ok: true },
 *   });
 *   vi.mocked(createClient).mockResolvedValue(sb);
 *
 * Each select returns the same canned response for any chain that resolves
 * via `.single()`, `.maybeSingle()`, or implicit promise resolution. Good
 * enough for happy-path tests; widen if a sad-path test needs a different
 * shape.
 */

type CannedResponse = { data: unknown; error: { code?: string; message: string } | null };

export type SupabaseMockOpts = {
  auth?: { user: { id: string; email: string } | null };
  /** Map of table name → response returned for any select chain on that table. */
  selects?: Record<string, Partial<CannedResponse> & { data?: unknown }>;
  /** Default response for INSERT / UPDATE / DELETE on any table. */
  mutations?: Partial<CannedResponse>;
};

export function makeSupabaseMock(opts: SupabaseMockOpts = {}) {
  const auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user: opts.auth?.user ?? null } }),
  };

  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

  function tableBuilder(table: string) {
    const selectResp: CannedResponse = {
      data: opts.selects?.[table]?.data ?? null,
      error: opts.selects?.[table]?.error ?? null,
    };
    const mutationResp: CannedResponse = {
      data: opts.mutations?.data ?? null,
      error: opts.mutations?.error ?? null,
    };

    // The query builder is a thenable: every chain method returns `this`,
    // and `.then`/.single()/.maybeSingle() resolve to the canned response.
    // Supabase's PostgrestBuilder is also thenable so this matches.
    const builder: Record<string, unknown> & PromiseLike<CannedResponse> = {
      select: vi.fn(() => builder),
      insert: vi.fn(() => ({
        ...builder,
        // INSERT chains often look like .insert(...).select(...).single()
        // — make sure those resolve to the mutation response, not the
        // (unrelated) select canned data.
        select: vi.fn(() => ({ ...builder, then: makeThen(mutationResp) })),
        single: vi.fn().mockResolvedValue(mutationResp),
        then: makeThen(mutationResp),
      })),
      update: vi.fn(() => ({
        ...builder,
        select: vi.fn(() => ({ ...builder, then: makeThen(mutationResp) })),
        single: vi.fn().mockResolvedValue(mutationResp),
        then: makeThen(mutationResp),
      })),
      delete: vi.fn(() => ({ ...builder, then: makeThen(mutationResp) })),
      eq: vi.fn(() => builder),
      ilike: vi.fn(() => builder),
      is: vi.fn(() => builder),
      in: vi.fn(() => builder),
      not: vi.fn(() => builder),
      lt: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      single: vi.fn().mockResolvedValue(selectResp),
      maybeSingle: vi.fn().mockResolvedValue(selectResp),
      then: makeThen(selectResp),
    };

    return builder;
  }

  return {
    auth,
    from: vi.fn((table: string) => tableBuilder(table)),
    rpc,
  };
}

// `then` on a PromiseLike has a richer signature than `(resolve) => …` —
// we'd have to thread generics through to satisfy TS. Cast instead; the
// runtime contract (forward to a resolved Promise) is what matters here.
function makeThen(resp: CannedResponse): PromiseLike<CannedResponse>["then"] {
  return ((onfulfilled?: ((value: CannedResponse) => unknown) | null) =>
    Promise.resolve(resp).then(onfulfilled ?? undefined)) as PromiseLike<CannedResponse>["then"];
}
