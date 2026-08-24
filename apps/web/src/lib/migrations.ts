import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Database migrations, applied from inside the app.
 *
 * Migrations live in `supabase/migrations/` as `NNN_name.sql` and used to be
 * applied by hand (psql / Studio) with no record kept — which is how 042 got
 * merged and never applied. Migration 043 adds a `schema_migrations` ledger;
 * this module is everything the MCP needs to read that ledger and add to it.
 *
 * Two hard rules, both here rather than in the tool layer:
 *   1. Only the LOWEST-numbered pending migration may run. No "run all", no
 *      skipping ahead, no re-running.
 *   2. If the ledger table doesn't exist yet, the ONLY file permitted is
 *      043 itself — the bootstrap. That's what lets the whole thing come up
 *      without anyone SSHing anywhere.
 *
 * Everything degrades when `SUPABASE_DB_URL` is unset: the tools report
 * "not configured on this deployment" and the rest of the MCP is unaffected.
 */

/** `NNN_lower_snake.sql` — the shape every file in supabase/migrations/ has. */
export const MIGRATION_FILENAME_RE = /^(\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** The migration that creates the ledger. The one file allowed to bootstrap. */
export const LEDGER_MIGRATION = "043_schema_migrations.sql";

export const LEDGER_TABLE = "schema_migrations";

export interface MigrationFile {
  filename: string;
  /** The numeric prefix, e.g. 43 for `043_schema_migrations.sql`. */
  number: number;
  /** sha256 hex of the file contents. */
  checksum: string;
}

export interface LedgerRow {
  filename: string;
  checksum: string | null;
  applied_at: string;
  applied_by: string | null;
}

export interface Drift {
  filename: string;
  stored: string;
  current: string;
}

export interface MigrationStatus {
  /** Is SUPABASE_DB_URL set? When false, everything below the file list is unknown. */
  configured: boolean;
  /** Resolved migrations directory, or null if none of the candidates exist. */
  dir: string | null;
  /** Files on disk, numerically ordered. */
  files: MigrationFile[];
  /** Filenames in the directory that don't match `NNN_name.sql` (ignored, but reported). */
  ignored: string[];
  /** False when the `schema_migrations` table doesn't exist yet (pre-bootstrap). */
  ledgerExists: boolean;
  applied: LedgerRow[];
  pending: MigrationFile[];
  /** Ledger rows with a stored checksum that no longer matches the file. */
  drift: Drift[];
  /** Ledger rows with no corresponding file on disk (renamed or deleted). */
  orphans: LedgerRow[];
}

// ── pure helpers ────────────────────────────────────────────

export function sha256Hex(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

/** The numeric prefix of a valid migration filename, or null if it isn't one. */
export function migrationNumber(filename: string): number | null {
  const m = MIGRATION_FILENAME_RE.exec(filename);
  return m ? Number(m[1]) : null;
}

/**
 * Split a directory listing into valid migration filenames (numerically ordered)
 * and everything else. Ordering is by the numeric prefix, not lexicographic —
 * they agree today at three digits but won't at 1000, and the sort is the thing
 * "apply in order" rests on.
 */
export function sortMigrationFilenames(names: string[]): { valid: string[]; ignored: string[] } {
  const valid: { name: string; n: number }[] = [];
  const ignored: string[] = [];
  for (const name of names) {
    const n = migrationNumber(name);
    if (n === null) ignored.push(name);
    else valid.push({ name, n });
  }
  valid.sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
  return { valid: valid.map((v) => v.name), ignored: ignored.sort() };
}

/** Files with no ledger row, in order. */
export function computePending(files: MigrationFile[], applied: LedgerRow[]): MigrationFile[] {
  const seen = new Set(applied.map((r) => r.filename));
  return files.filter((f) => !seen.has(f.filename));
}

/**
 * Ledger rows whose stored checksum disagrees with the file on disk. NULL
 * checksums are baseline rows (applied before the ledger existed) and are
 * skipped — there's nothing to compare against, and inventing a comparison
 * would turn a known unknown into a false alarm.
 */
export function detectDrift(files: MigrationFile[], applied: LedgerRow[]): Drift[] {
  const byName = new Map(files.map((f) => [f.filename, f]));
  const out: Drift[] = [];
  for (const row of applied) {
    if (!row.checksum) continue;
    const file = byName.get(row.filename);
    if (file && file.checksum !== row.checksum) {
      out.push({ filename: row.filename, stored: row.checksum, current: file.checksum });
    }
  }
  return out;
}

/** Ledger rows with no file on disk — a migration was renamed or deleted after it ran. */
export function detectOrphans(files: MigrationFile[], applied: LedgerRow[]): LedgerRow[] {
  const onDisk = new Set(files.map((f) => f.filename));
  return applied.filter((r) => !onDisk.has(r.filename));
}

export type ApplyCheck = { ok: true; bootstrap: boolean } | { ok: false; reason: string };

/**
 * May `filename` be applied right now? The whole safety story lives here so it
 * can be tested without a database.
 */
export function checkApplyAllowed(p: {
  filename: string;
  files: MigrationFile[];
  applied: LedgerRow[];
  ledgerExists: boolean;
}): ApplyCheck {
  const { filename, files, applied, ledgerExists } = p;

  if (migrationNumber(filename) === null) {
    return { ok: false, reason: `"${filename}" is not a migration filename — expected NNN_name.sql (e.g. 044_add_thing.sql).` };
  }
  const file = files.find((f) => f.filename === filename);
  if (!file) {
    return { ok: false, reason: `"${filename}" is not in the migrations directory of this deployment. Has the code that adds it been deployed?` };
  }

  if (!ledgerExists) {
    if (filename !== LEDGER_MIGRATION) {
      return {
        ok: false,
        reason:
          `The ${LEDGER_TABLE} ledger doesn't exist yet, so the only migration that can run is ${LEDGER_MIGRATION} ` +
          `(it creates the ledger and seeds it with everything already applied). Run that first, then retry "${filename}".`,
      };
    }
    return { ok: true, bootstrap: true };
  }

  const pending = computePending(files, applied);
  if (!pending.some((f) => f.filename === filename)) {
    const row = applied.find((r) => r.filename === filename);
    return {
      ok: false,
      reason: row
        ? `${filename} was already applied at ${row.applied_at} by ${row.applied_by ?? "unknown"}. Migrations never re-run.`
        : `${filename} is not pending.`,
    };
  }
  const lowest = pending[0];
  if (lowest.filename !== filename) {
    return {
      ok: false,
      reason:
        `Out of order: ${lowest.filename} is pending and comes first. ` +
        `Apply migrations lowest-number-first — run ${lowest.filename}, then ${filename}.`,
    };
  }
  return { ok: true, bootstrap: false };
}

// ── filesystem ──────────────────────────────────────────────

/**
 * Where `supabase/migrations/` might be, most-specific first.
 *
 * Three shapes matter:
 *   - `MIGRATIONS_DIR` env override — always wins.
 *   - The container. The Dockerfile copies the directory to `/app/apps/web/supabase/migrations`
 *     (WORKDIR of the runner stage). Next's standalone `server.js` chdir()s to its own
 *     directory, which is double-nested for a pnpm monorepo (`/app/apps/web/apps/web` —
 *     see CLAUDE.md), so BOTH `cwd/supabase/migrations` and `cwd/../../supabase/migrations`
 *     are tried and one of them hits regardless of which cwd we actually get.
 *   - Local dev / vitest, where cwd is `apps/web` and the repo root is two up — which is
 *     the same `../../` candidate. One list covers all of it.
 */
export function migrationsDirCandidates(cwd: string = process.cwd()): string[] {
  const override = process.env.MIGRATIONS_DIR;
  return [
    ...(override ? [override] : []),
    path.join(cwd, "supabase", "migrations"),
    path.resolve(cwd, "..", "..", "supabase", "migrations"),
    path.resolve(cwd, "..", "supabase", "migrations"),
  ];
}

/** First candidate directory that exists, or null. */
export function resolveMigrationsDir(cwd: string = process.cwd()): string | null {
  return migrationsDirCandidates(cwd).find((d) => existsSync(d)) ?? null;
}

/** Read + hash every migration file on disk, numerically ordered. */
export async function readMigrationFiles(
  dir: string,
): Promise<{ files: MigrationFile[]; ignored: string[] }> {
  const entries = await readdir(dir);
  const { valid, ignored } = sortMigrationFilenames(entries);
  const files: MigrationFile[] = [];
  for (const filename of valid) {
    const contents = await readFile(path.join(dir, filename), "utf8");
    files.push({ filename, number: migrationNumber(filename)!, checksum: sha256Hex(contents) });
  }
  return { files, ignored };
}

// ── database ────────────────────────────────────────────────

export function isMigrationsConfigured(): boolean {
  return Boolean(process.env.SUPABASE_DB_URL);
}

export const NOT_CONFIGURED =
  "Migrations are not configured on this deployment: SUPABASE_DB_URL is unset. " +
  "Set it in Coolify on the web app (a postgres:// URL for the supabase_admin role) and redeploy.";

/**
 * A minimal `pg.Client`. Typed structurally so tests can hand us a fake and so
 * the `pg` import stays dynamic — nothing loads the driver until a migration
 * tool is actually called.
 */
interface PgLike {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

async function withClient<T>(fn: (client: PgLike) => Promise<T>): Promise<T> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL }) as unknown as PgLike;
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Does `public.schema_migrations` exist? Cheap, and the bootstrap hinges on it. */
async function ledgerExists(client: PgLike): Promise<boolean> {
  const res = await client.query(`select to_regclass('public.${LEDGER_TABLE}') as reg`);
  return Boolean(res.rows[0]?.reg);
}

async function readLedger(client: PgLike): Promise<LedgerRow[]> {
  const res = await client.query(
    `select filename, checksum, applied_at, applied_by from ${LEDGER_TABLE} order by filename`,
  );
  return res.rows.map((r) => ({
    filename: String(r.filename),
    checksum: r.checksum == null ? null : String(r.checksum),
    applied_at:
      r.applied_at instanceof Date ? r.applied_at.toISOString() : String(r.applied_at ?? ""),
    applied_by: r.applied_by == null ? null : String(r.applied_by),
  }));
}

/** Everything list_migrations needs. Never throws for "unconfigured" — that's a state, not an error. */
export async function getMigrationStatus(): Promise<MigrationStatus> {
  const dir = resolveMigrationsDir();
  const { files, ignored } = dir ? await readMigrationFiles(dir) : { files: [], ignored: [] };

  const base: MigrationStatus = {
    configured: isMigrationsConfigured(),
    dir,
    files,
    ignored,
    ledgerExists: false,
    applied: [],
    pending: [],
    drift: [],
    orphans: [],
  };
  if (!base.configured) return base;

  return withClient(async (client) => {
    const exists = await ledgerExists(client);
    const applied = exists ? await readLedger(client) : [];
    return {
      ...base,
      ledgerExists: exists,
      applied,
      pending: exists ? computePending(files, applied) : files,
      drift: detectDrift(files, applied),
      orphans: detectOrphans(files, applied),
    };
  });
}

export type ApplyResult =
  | { ok: true; filename: string; checksum: string; bootstrap: boolean; status: MigrationStatus }
  | { ok: false; error: string };

/**
 * Apply exactly one migration, in one transaction: BEGIN, the file's SQL, the
 * ledger row, COMMIT. Any failure rolls the whole thing back, so a half-applied
 * migration can't exist and the ledger can't claim something that didn't land.
 */
export async function applyMigration(filename: string, appliedBy: string): Promise<ApplyResult> {
  if (!isMigrationsConfigured()) return { ok: false, error: NOT_CONFIGURED };

  const dir = resolveMigrationsDir();
  if (!dir) {
    return {
      ok: false,
      error: "Could not find a supabase/migrations directory on this deployment. Set MIGRATIONS_DIR if it lives somewhere unusual.",
    };
  }

  const { files } = await readMigrationFiles(dir);

  return withClient(async (client) => {
    const exists = await ledgerExists(client);
    const applied = exists ? await readLedger(client) : [];

    const check = checkApplyAllowed({ filename, files, applied, ledgerExists: exists });
    if (!check.ok) return { ok: false as const, error: check.reason };

    const file = files.find((f) => f.filename === filename)!;
    const sql = await readFile(path.join(dir, filename), "utf8");

    // Guard against an edit landing between hashing and reading.
    if (sha256Hex(sql) !== file.checksum) {
      return { ok: false as const, error: `${filename} changed on disk while it was being read — nothing was applied.` };
    }

    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        `insert into ${LEDGER_TABLE} (filename, checksum, applied_by) values ($1, $2, $3)
         on conflict (filename) do update
           set checksum = excluded.checksum,
               applied_at = now(),
               applied_by = excluded.applied_by`,
        [filename, file.checksum, appliedBy],
      );
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: `${filename} failed and was rolled back — nothing was applied. Postgres said: ${msg}` };
    }

    const nowApplied = await readLedger(client);
    return {
      ok: true as const,
      filename,
      checksum: file.checksum,
      bootstrap: check.bootstrap,
      status: {
        configured: true,
        dir,
        files,
        ignored: [],
        ledgerExists: true,
        applied: nowApplied,
        pending: computePending(files, nowApplied),
        drift: detectDrift(files, nowApplied),
        orphans: detectOrphans(files, nowApplied),
      },
    };
  });
}
