import { vi } from "vitest";

/**
 * In-memory stand-in for the Supabase/PostgREST query builder.
 *
 * Unlike `mockSupabase.ts` (one canned response per table), this keeps real
 * rows and applies the filters, so a test can run a cancel and then the real
 * invoice generator against the same state and see what it would have done.
 * Only the builder surface the billing code uses is implemented; anything
 * else throws so a silent no-op can't make a test pass.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type Result = { data: unknown; error: { code?: string; message: string } | null };

export type MemoryDbOptions = {
  user?: { id: string; email: string } | null;
  rpcs?: Record<string, (args: Record<string, unknown>) => unknown>;
};

function compare(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string") {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && /^\d{4}-/.test(a) && /^\d{4}-/.test(b)) return ta - tb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return Number(a) - Number(b);
}

export function makeMemoryDb(seed: Record<string, Row[]> = {}, opts: MemoryDbOptions = {}) {
  const tables: Record<string, Row[]> = {};
  const nextId: Record<string, number> = {};
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((row) => ({ ...row }));
    nextId[name] = Math.max(0, ...rows.map((row) => Number(row.id) || 0)) + 1;
  }
  const table = (name: string) => (tables[name] ??= []);

  function builder(name: string) {
    const filters: Filter[] = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: Row | Row[] = {};
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let returning = false;
    let order: { col: string; ascending: boolean } | null = null;
    let limit: number | null = null;

    function run(): Row[] {
      const rows = table(name);
      if (op === "insert" || op === "upsert") {
        const out: Row[] = [];
        for (const value of Array.isArray(payload) ? payload : [payload]) {
          const keys = upsertOpts.onConflict?.split(",").map((k) => k.trim());
          const existing = keys ? rows.find((row) => keys.every((k) => row[k] === value[k])) : undefined;
          if (existing) {
            if (op === "insert") throw Object.assign(new Error("duplicate key"), { code: "23505" });
            if (upsertOpts.ignoreDuplicates) continue;
            Object.assign(existing, value);
            out.push(existing);
            continue;
          }
          const row = { id: nextId[name] = (nextId[name] ?? 1), created_at: new Date().toISOString(), ...value };
          nextId[name] = Number(row.id) + 1;
          rows.push(row);
          out.push(row);
        }
        return out;
      }
      let matched = rows.filter((row) => filters.every((f) => f(row)));
      if (op === "update") {
        for (const row of matched) Object.assign(row, payload);
        return matched;
      }
      if (op === "delete") {
        tables[name] = rows.filter((row) => !matched.includes(row));
        return matched;
      }
      if (order) {
        const { col, ascending } = order;
        matched = [...matched].sort((a, b) => compare(a[col], b[col]) * (ascending ? 1 : -1));
      }
      if (limit != null) matched = matched.slice(0, limit);
      return matched.map((row) => ({ ...row }));
    }

    function settle(mode: "many" | "single" | "maybe"): Result {
      try {
        const rows = run();
        const isRead = op === "select";
        if (!isRead && !returning && mode === "many") return { data: null, error: null };
        if (mode === "many") return { data: rows, error: null };
        if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
        if (rows.length === 0) {
          return mode === "single"
            ? { data: null, error: { code: "PGRST116", message: "no rows" } }
            : { data: null, error: null };
        }
        return { data: rows[0], error: null };
      } catch (error) {
        const e = error as { code?: string; message: string };
        return { data: null, error: { code: e.code, message: e.message } };
      }
    }

    const b = {
      select: () => { if (op !== "select") returning = true; return b; },
      insert: (value: Row | Row[]) => { op = "insert"; payload = value; return b; },
      upsert: (value: Row | Row[], o: typeof upsertOpts = {}) => { op = "upsert"; payload = value; upsertOpts = o; return b; },
      update: (value: Row) => { op = "update"; payload = value; return b; },
      delete: () => { op = "delete"; return b; },
      eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return b; },
      neq: (col: string, v: unknown) => { filters.push((r) => r[col] !== v); return b; },
      in: (col: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[col])); return b; },
      is: (col: string, v: null | boolean) => { filters.push((r) => (r[col] ?? null) === v); return b; },
      not: (col: string, operator: string, v: unknown) => {
        if (operator !== "is") throw new Error(`memoryDb: not(${operator}) unsupported`);
        filters.push((r) => (r[col] ?? null) !== v);
        return b;
      },
      lt: (col: string, v: unknown) => { filters.push((r) => r[col] != null && compare(r[col], v) < 0); return b; },
      lte: (col: string, v: unknown) => { filters.push((r) => r[col] != null && compare(r[col], v) <= 0); return b; },
      gt: (col: string, v: unknown) => { filters.push((r) => r[col] != null && compare(r[col], v) > 0); return b; },
      gte: (col: string, v: unknown) => { filters.push((r) => r[col] != null && compare(r[col], v) >= 0); return b; },
      order: (col: string, o: { ascending?: boolean } = {}) => { order = { col, ascending: o.ascending ?? true }; return b; },
      limit: (n: number) => { limit = n; return b; },
      returns: () => b,
      single: async () => settle("single"),
      maybeSingle: async () => settle("maybe"),
      then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(settle("many")).then(resolve, reject),
    };
    return b;
  }

  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
    rpcCalls.push({ name, args });
    const handler = opts.rpcs?.[name];
    if (handler) return { data: handler(args), error: null };
    if (["acquire_lock_writer", "check_lock_writer", "release_lock_writer"].includes(name)) return { data: true, error: null };
    if (name === "list_lock_quarantines") return { data: [], error: null };
    return { data: null, error: null };
  });

  return {
    tables,
    rpcCalls,
    from: vi.fn((name: string) => builder(name)),
    rpc,
    auth: {
      getUser: vi.fn(async () => ({ data: { user: opts.user ?? null } })),
      admin: {
        listUsers: vi.fn(async () => ({
          data: { users: (tables.auth_users ?? []).map((u) => ({ ...u })) },
          error: null,
        })),
      },
    },
  };
}

export type MemoryDb = ReturnType<typeof makeMemoryDb>;
