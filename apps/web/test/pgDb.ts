import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { lockWriterFetch } from "@regenhub/shared";

/**
 * A Supabase service client backed by a real Postgres (PGlite) with every
 * migration in supabase/migrations applied: the code under test runs its real
 * queries, RPCs and triggers. It speaks the PostgREST builder subset the
 * billing and door-code code uses; anything else throws, so a silent no-op
 * can't make a test pass. Each request is its own transaction, as with
 * PostgREST, and carries the PIN-writer header when inside withLockWriter.
 */

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string; message: string } | null; count?: number | null };
type WriteHook = { table: string; run: () => Promise<unknown> | unknown };

const MIGRATIONS = new URL("../../../supabase/migrations/", import.meta.url);
let base: Promise<PGlite> | null = null;

async function migrated(): Promise<PGlite> {
  const pg = new PGlite();
  // The Supabase pieces the migrations assume exist.
  await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls; create role supabase_admin;
    create schema auth;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb, created_at timestamptz default now(),
      last_sign_in_at timestamptz, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role', true) $$;
    create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$;`);
  for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort()) {
    await pg.exec(await readFile(new URL(file, MIGRATIONS), "utf8"));
  }
  return pg;
}

/** The PIN-writer token of the current withLockWriter scope, read the way the real client sends it. */
function writerToken(): string | null {
  const original = globalThis.fetch;
  let token: string | null = null;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    token = new Headers(init?.headers).get("x-lock-writer-token");
    return Promise.resolve(new Response(null));
  }) as typeof fetch;
  try { void lockWriterFetch("http://pgdb.local/"); } finally { globalThis.fetch = original; }
  return token;
}

function fromPg(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(fromPg);
  return value;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

type Projection = { columns: string[] | "*"; embeds: { name: string; table: string; projection: Projection }[] };

function parseSelect(text = "*"): Projection {
  const columns: string[] = [];
  const embeds: Projection["embeds"] = [];
  let star = false;
  for (const part of splitTopLevel(text)) {
    const embed = /^(?:(\w+):)?(\w+)(?:!\w+)?\((.*)\)$/s.exec(part);
    if (embed) embeds.push({ name: embed[1] ?? embed[2], table: embed[2], projection: parseSelect(embed[3]) });
    else if (part === "*") star = true;
    else columns.push(part);
  }
  return { columns: star ? "*" : columns, embeds };
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`pgDb: unsupported identifier ${name}`);
  return `"${name}"`;
};

export async function makePgDb() {
  base ??= migrated();
  const pg = await (await base).clone();
  const hooks: WriteHook[] = [];
  let inHook = false;

  async function runHook(key: string) {
    const hook = inHook ? -1 : hooks.findIndex((h) => h.table === key);
    if (hook < 0) return;
    inHook = true;
    try { await hooks.splice(hook, 1)[0].run(); } finally { inHook = false; }
  }

  const meta = await pg.query<{ tbl: string; col: string; ref: string }>(`
    select c.conrelid::regclass::text tbl, a.attname col, c.confrelid::regclass::text ref
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and array_length(c.conkey, 1) = 1`);
  const fks = meta.rows;
  const jsonColumns = new Set((await pg.query<{ k: string }>(`
    select table_name || '.' || column_name k from information_schema.columns
    where table_schema = 'public' and data_type in ('json', 'jsonb')`)).rows.map((r) => r.k));

  async function request<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const token = writerToken();
    return pg.transaction(async (tx) => {
      await tx.query("select set_config('request.headers', $1, true), set_config('request.jwt.claim.role', 'service_role', true)",
        [JSON.stringify(token ? { "x-lock-writer-token": token } : {})]);
      return work(tx);
    });
  }

  async function project(tx: Transaction, table: string, rows: Row[], projection: Projection): Promise<Row[]> {
    const out: Row[] = [];
    for (const row of rows) {
      const shaped: Row = {};
      if (projection.columns === "*") Object.assign(shaped, row);
      else for (const col of projection.columns) {
        const [alias, name] = col.includes(":") ? col.split(":") : [col, col];
        shaped[alias] = row[name];
      }
      for (const embed of projection.embeds) {
        const parent = fks.find((fk) => fk.tbl === table && fk.ref === embed.table);
        const child = fks.find((fk) => fk.tbl === embed.table && fk.ref === table);
        if (parent) {
          const found = row[parent.col] == null ? [] : (await tx.query<Row>(
            `select * from ${ident(embed.table)} where id = $1`, [row[parent.col]])).rows.map(normalize);
          shaped[embed.name] = (await project(tx, embed.table, found, embed.projection))[0] ?? null;
        } else if (child) {
          const found = (await tx.query<Row>(
            `select * from ${ident(embed.table)} where ${ident(child.col)} = $1 order by id`, [row.id])).rows.map(normalize);
          shaped[embed.name] = await project(tx, embed.table, found, embed.projection);
        } else {
          throw new Error(`pgDb: no foreign key between ${table} and ${embed.table}`);
        }
      }
      out.push(shaped);
    }
    return out;
  }

  function normalize(row: Row): Row {
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fromPg(v)]));
  }

  function toPg(table: string, column: string, value: unknown): unknown {
    if (value !== null && typeof value === "object" && jsonColumns.has(`${table}.${column}`)) return JSON.stringify(value);
    return value;
  }

  function builder(table: string) {
    const where: string[] = [];
    const params: unknown[] = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: Row | Row[] = {};
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let projection: Projection | null = null;
    const orders: string[] = [];
    let limit: number | null = null;
    let countMode = false;
    let headOnly = false;

    const param = (value: unknown) => { params.push(value); return `$${params.length}`; };
    const filter = (sql: string) => { where.push(sql); return b; };

    async function run(tx: Transaction): Promise<Row[]> {
      const clause = where.length ? ` where ${where.join(" and ")}` : "";
      let sql: string;
      let args = params;
      if (op === "select") {
        sql = `select * from ${ident(table)}${clause}${orders.length ? ` order by ${orders.join(", ")}` : ""}${limit != null ? ` limit ${limit}` : ""}`;
      } else if (op === "delete") {
        sql = `delete from ${ident(table)}${clause} returning *`;
      } else if (op === "update") {
        const sets = Object.entries(payload as Row).map(([k, v]) => `${ident(k)} = ${param(toPg(table, k, v))}`);
        sql = `update ${ident(table)} set ${sets.join(", ")}${clause} returning *`;
      } else {
        const rows = Array.isArray(payload) ? payload : [payload];
        const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        args = [];
        const values = rows.map((row) => `(${keys.map((k) => {
          if (!(k in row)) return "default";
          args.push(toPg(table, k, row[k]));
          return `$${args.length}`;
        }).join(", ")})`);
        let conflict = "";
        if (op === "upsert") {
          const target = (upsertOpts.onConflict ?? "id").split(",").map((k) => ident(k.trim())).join(", ");
          conflict = upsertOpts.ignoreDuplicates
            ? ` on conflict (${target}) do nothing`
            : ` on conflict (${target}) do update set ${keys.map((k) => `${ident(k)} = excluded.${ident(k)}`).join(", ")}`;
        }
        sql = `insert into ${ident(table)} (${keys.map(ident).join(", ")}) values ${values.join(", ")}${conflict} returning *`;
      }
      const rows = (await tx.query<Row>(sql, args)).rows.map(normalize);
      return projection ? project(tx, table, rows, projection) : rows;
    }

    async function settle(mode: "many" | "single" | "maybe"): Promise<Result> {
      if (op !== "select") await runHook(table);
      try {
        const rows = await request((tx) => run(tx));
        if (countMode) return { data: headOnly ? null : rows, error: null, count: rows.length };
        if (op !== "select" && !projection && mode === "many") return { data: null, error: null };
        if (mode === "many") return { data: rows, error: null };
        if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
        if (!rows.length) return mode === "single" ? { data: null, error: { code: "PGRST116", message: "no rows" } } : { data: null, error: null };
        return { data: rows[0], error: null };
      } catch (error) {
        const e = error as { code?: string; message: string };
        return { data: null, error: { code: e.code, message: e.message } };
      }
    }

    const b = {
      select: (columns?: string, opts?: { count?: string; head?: boolean }) => {
        projection = parseSelect(columns);
        countMode = !!opts?.count;
        headOnly = !!opts?.head;
        return b;
      },
      insert: (value: Row | Row[]) => { op = "insert"; payload = value; return b; },
      upsert: (value: Row | Row[], opts: typeof upsertOpts = {}) => { op = "upsert"; payload = value; upsertOpts = opts; return b; },
      update: (value: Row) => { op = "update"; payload = value; return b; },
      delete: () => { op = "delete"; return b; },
      eq: (col: string, v: unknown) => filter(`${ident(col)} = ${param(v)}`),
      neq: (col: string, v: unknown) => filter(`${ident(col)} <> ${param(v)}`),
      in: (col: string, vs: unknown[]) => filter(vs.length ? `${ident(col)} in (${vs.map(param).join(", ")})` : "false"),
      is: (col: string, v: null | boolean) => filter(`${ident(col)} is ${v === null ? "null" : v ? "true" : "false"}`),
      not: (col: string, operator: string, v: unknown) => {
        if (operator !== "is" || v !== null) throw new Error(`pgDb: not(${operator}, ${String(v)}) unsupported`);
        return filter(`${ident(col)} is not null`);
      },
      lt: (col: string, v: unknown) => filter(`${ident(col)} < ${param(v)}`),
      lte: (col: string, v: unknown) => filter(`${ident(col)} <= ${param(v)}`),
      gt: (col: string, v: unknown) => filter(`${ident(col)} > ${param(v)}`),
      gte: (col: string, v: unknown) => filter(`${ident(col)} >= ${param(v)}`),
      order: (col: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) => {
        orders.push(`${ident(col)} ${opts.ascending === false ? "desc" : "asc"} nulls ${opts.nullsFirst ? "first" : "last"}`);
        return b;
      },
      limit: (n: number) => { limit = n; return b; },
      returns: () => b,
      single: () => settle("single"),
      maybeSingle: () => settle("maybe"),
      then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => settle("many").then(resolve, reject),
    };
    return b;
  }

  const procs = new Map((await pg.query<{ name: string; retset: boolean; ret: string; argnames: string[] | null; argtypes: string[] }>(`
    select p.proname name, p.proretset retset, p.prorettype::regtype::text ret, p.proargnames argnames,
      array(select unnest(p.proargtypes::regtype[])::text) argtypes
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)).rows.map((r) => [r.name, r]));

  async function rpc(name: string, args: Record<string, unknown> = {}): Promise<Result> {
    await runHook(`rpc:${name}`);
    const proc = procs.get(name);
    if (!proc) return { data: null, error: { code: "PGRST202", message: `function ${name} not found` } };
    const values: unknown[] = [];
    const named = Object.entries(args).map(([key, value]) => {
      const type = proc.argtypes[proc.argnames?.indexOf(key) ?? -1];
      values.push(value !== null && typeof value === "object" && /json/.test(type ?? "") ? JSON.stringify(value) : value);
      return `${ident(key)} => $${values.length}`;
    });
    const call = `${ident(name)}(${named.join(", ")})`;
    try {
      const rows = await request(async (tx) => (await tx.query<Row>(
        proc.retset || proc.ret === "record" ? `select * from ${call}` : `select ${call} as value`, values)).rows.map(normalize));
      if (proc.retset) return { data: rows, error: null };
      return { data: proc.ret === "void" ? null : rows[0]?.value ?? null, error: null };
    } catch (error) {
      const e = error as { code?: string; message: string };
      return { data: null, error: { code: e.code, message: e.message } };
    }
  }

  return {
    pg: pg as PGliteInterface,
    from: (table: string) => builder(table),
    rpc,
    /**
     * Run once, just before the next write to `table` (or the next call of
     * `rpc:<name>`): a stand-in for a request that lands in between.
     */
    beforeNextWrite: (table: string, run: WriteHook["run"]) => { hooks.push({ table, run }); },
    /** Direct SQL for seeding and assertions (no PIN-writer header). */
    sql: async <T extends Row = Row>(text: string, args: unknown[] = []) =>
      (await pg.query<T>(text, args)).rows.map((row) => normalize(row) as T),
    /** Several statements at once (DDL in tests). */
    exec: async (text: string) => { await pg.exec(text); },
    close: () => pg.close(),
  };
}

export type PgDb = Awaited<ReturnType<typeof makePgDb>>;
