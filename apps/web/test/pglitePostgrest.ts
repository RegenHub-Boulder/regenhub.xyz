import type { PGlite } from "@electric-sql/pglite";

/**
 * A `fetch` that answers the slice of Supabase's HTTP API this app's wallet
 * code uses — PostgREST table reads/writes, `rpc/<fn>`, and GoTrue's
 * `GET /auth/v1/user` — straight from a PGlite database. Lets route tests run
 * the real supabase-js client and the real SQL functions with no server.
 *
 * Deliberately small: no RLS (every query runs as the PGlite superuser, like
 * the service role), no embedded selects, no `or=` filters. Anything it
 * doesn't understand fails loudly with a 501 rather than guessing.
 */

export type FakeAuthUser = { id: string; email: string };

export const SESSION_COOKIE = "sb-regenhub";

/** The cookie `@supabase/ssr` reads for a signed-in session (see lib/supabase/server.ts). */
export function sessionCookieValue(accessToken: string, user: FakeAuthUser) {
  const session = {
    access_token: accessToken,
    refresh_token: `refresh-${accessToken}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 365,
    user: { ...user, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} },
  };
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Unsupported(`identifier ${name}`);
  return `"${name}"`;
};

class Unsupported extends Error {}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function pgError(error: unknown) {
  const e = error as { code?: string; message?: string; detail?: string; hint?: string };
  const status = e.code === "23505" ? 409 : e.code === "42501" ? 403 : 400;
  return json(status, { code: e.code ?? "XX000", message: e.message ?? String(error), details: e.detail ?? null, hint: e.hint ?? null });
}

function selectList(select: string | null) {
  if (!select || select === "*") return "*";
  return select.split(",").map((col) => {
    if (col.includes("(") || col.includes(":")) throw new Unsupported(`select ${col}`);
    return ident(col.trim());
  }).join(", ");
}

const OPS: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", ilike: "ilike" };

function parseList(raw: string) {
  // in.(a,b,"c d")
  const inner = raw.replace(/^\(/, "").replace(/\)$/, "");
  return inner === "" ? [] : inner.split(",").map((v) => v.replace(/^"(.*)"$/, "$1"));
}

function whereClause(params: URLSearchParams, args: unknown[]) {
  const reserved = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
  const parts: string[] = [];
  for (const [key, raw] of params) {
    if (reserved.has(key)) continue;
    if (key === "or" || key === "and") throw new Unsupported(key);
    let value = raw;
    let negate = false;
    if (value.startsWith("not.")) { negate = true; value = value.slice(4); }
    const dot = value.indexOf(".");
    const op = value.slice(0, dot);
    const operand = value.slice(dot + 1);
    let clause: string;
    if (op === "is") {
      if (!["null", "true", "false"].includes(operand)) throw new Unsupported(`is.${operand}`);
      clause = `${ident(key)} is ${operand}`;
    } else if (op === "in") {
      const list = parseList(operand);
      if (list.length === 0) clause = "false";
      else {
        clause = `${ident(key)}::text in (${list.map((v) => { args.push(v); return `$${args.length}`; }).join(", ")})`;
      }
    } else if (OPS[op]) {
      args.push(operand);
      clause = `${ident(key)} ${OPS[op]} $${args.length}`;
    } else {
      throw new Unsupported(`operator ${op}`);
    }
    parts.push(negate ? `not (${clause})` : clause);
  }
  return parts.length ? ` where ${parts.join(" and ")}` : "";
}

function orderClause(order: string | null) {
  if (!order) return "";
  return " order by " + order.split(",").map((term) => {
    const [col, ...mods] = term.split(".");
    const dir = mods.includes("desc") ? " desc" : " asc";
    const nulls = mods.includes("nullsfirst") ? " nulls first" : mods.includes("nullslast") ? " nulls last" : "";
    return `${ident(col)}${dir}${nulls}`;
  }).join(", ");
}

function shape(rows: Record<string, unknown>[], headers: Headers, method: string, extra: Record<string, string> = {}) {
  const accept = headers.get("Accept") ?? "";
  if (accept.includes("application/vnd.pgrst.object+json")) {
    if (rows.length !== 1) {
      return json(406, {
        code: "PGRST116",
        details: `The result contains ${rows.length} rows`,
        hint: null,
        message: "JSON object requested, multiple (or no) rows returned",
      });
    }
    return json(200, rows[0], extra);
  }
  return json(method === "POST" ? 201 : 200, rows, extra);
}

export function pglitePostgrest(pg: PGlite, users: Map<string, FakeAuthUser>) {
  async function handle(url: URL, method: string, headers: Headers, bodyText: string | null): Promise<Response> {
    const path = url.pathname;
    if (path === "/auth/v1/user") {
      const token = headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      const user = users.get(token);
      return user
        ? json(200, { ...user, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} })
        : json(401, { code: 401, msg: "invalid JWT" });
    }
    const rpc = path.match(/^\/rest\/v1\/rpc\/([a-z_][a-z0-9_]*)$/);
    if (rpc) {
      const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};
      const args: unknown[] = [];
      const named = Object.entries(body).map(([k, v]) => { args.push(v); return `${ident(k)} => $${args.length}`; });
      try {
        const result = await pg.query(`select ${ident(rpc[1])}(${named.join(", ")}) as result`, args);
        return json(200, (result.rows[0] as { result: unknown }).result);
      } catch (error) { return pgError(error); }
    }
    const table = path.match(/^\/rest\/v1\/([a-z_][a-z0-9_]*)$/);
    if (!table) throw new Unsupported(`${method} ${path}`);
    const name = ident(table[1]);
    const params = url.searchParams;
    const prefer = headers.get("Prefer") ?? "";
    const returning = prefer.includes("return=representation") ? ` returning ${selectList(params.get("select"))}` : "";
    const args: unknown[] = [];
    try {
      if (method === "GET" || method === "HEAD") {
        const where = whereClause(params, args);
        let sql = `select ${selectList(params.get("select"))} from ${name}${where}${orderClause(params.get("order"))}`;
        if (params.get("limit")) sql += ` limit ${Number(params.get("limit"))}`;
        if (params.get("offset")) sql += ` offset ${Number(params.get("offset"))}`;
        const result = await pg.query(sql, args);
        const extra: Record<string, string> = {};
        if (/count=(exact|planned|estimated)/.test(prefer)) {
          const counted = await pg.query(`select count(*)::int n from ${name}${where}`, args);
          extra["Content-Range"] = `0-${Math.max(result.rows.length - 1, 0)}/${(counted.rows[0] as { n: number }).n}`;
        }
        if (method === "HEAD") return new Response(null, { status: 200, headers: extra });
        return shape(result.rows as Record<string, unknown>[], headers, method, extra);
      }
      if (method === "POST") {
        const body = JSON.parse(bodyText ?? "null") as Record<string, unknown> | Record<string, unknown>[];
        const records = Array.isArray(body) ? body : [body];
        const cols = [...new Set(records.flatMap((r) => Object.keys(r)))];
        const values = records.map((r) => `(${cols.map((c) => {
          const v = r[c];
          args.push(v !== null && typeof v === "object" ? JSON.stringify(v) : v);
          return `$${args.length}`;
        }).join(", ")})`);
        let conflict = "";
        const onConflict = params.get("on_conflict");
        if (onConflict) {
          const target = onConflict.split(",").map(ident).join(", ");
          conflict = prefer.includes("resolution=ignore-duplicates")
            ? ` on conflict (${target}) do nothing`
            : ` on conflict (${target}) do update set ${cols.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")}`;
        }
        const result = await pg.query(
          `insert into ${name} (${cols.map(ident).join(", ")}) values ${values.join(", ")}${conflict}${returning}`, args);
        return returning ? shape(result.rows as Record<string, unknown>[], headers, method) : new Response(null, { status: 201 });
      }
      if (method === "PATCH") {
        const body = JSON.parse(bodyText ?? "{}") as Record<string, unknown>;
        const sets = Object.entries(body).map(([k, v]) => {
          args.push(v !== null && typeof v === "object" ? JSON.stringify(v) : v);
          return `${ident(k)} = $${args.length}`;
        });
        const result = await pg.query(`update ${name} set ${sets.join(", ")}${whereClause(params, args)}${returning}`, args);
        return returning ? shape(result.rows as Record<string, unknown>[], headers, method) : new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        const result = await pg.query(`delete from ${name}${whereClause(params, args)}${returning}`, args);
        return returning ? shape(result.rows as Record<string, unknown>[], headers, method) : new Response(null, { status: 204 });
      }
    } catch (error) {
      if (error instanceof Unsupported) throw error;
      return pgError(error);
    }
    throw new Unsupported(`${method} ${path}`);
  }

  return async function fetchFromPglite(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const body = init?.body ?? null;
    try {
      return await handle(url, method, headers, typeof body === "string" ? body : body ? String(body) : null);
    } catch (error) {
      if (error instanceof Unsupported) {
        return json(501, { code: "FAKE501", message: `pglitePostgrest does not support ${error.message}` });
      }
      throw error;
    }
  };
}
