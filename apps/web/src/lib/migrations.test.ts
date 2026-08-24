import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// fs is mocked so these tests describe a migrations directory rather than the
// real one — the repo's own files keep changing and shouldn't fail the suite.
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => false) }));
vi.mock("node:fs/promises", () => ({ readdir: vi.fn(), readFile: vi.fn() }));
vi.mock("pg", () => ({ Client: vi.fn() }));

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  applyMigration,
  checkApplyAllowed,
  computePending,
  detectDrift,
  detectOrphans,
  getMigrationStatus,
  isMigrationsConfigured,
  LEDGER_MIGRATION,
  migrationNumber,
  migrationsDirCandidates,
  readMigrationFiles,
  resolveMigrationsDir,
  sha256Hex,
  sortMigrationFilenames,
  type LedgerRow,
  type MigrationFile,
} from "./migrations";

const DIR = "/repo/supabase/migrations";

/** A migration file with a stable, made-up checksum. */
const f = (filename: string, checksum = `sum-${filename}`): MigrationFile => ({
  filename,
  number: migrationNumber(filename)!,
  checksum,
});

const row = (filename: string, checksum: string | null = null, applied_by = "baseline"): LedgerRow => ({
  filename,
  checksum,
  applied_at: "2026-08-24T00:00:00.000Z",
  applied_by,
});

/**
 * Point the resolver at DIR and serve `contents` from it. Uses the
 * MIGRATIONS_DIR override so these tests don't depend on the real cwd —
 * resolution from cwd gets its own tests below.
 */
function mockDir(contents: Record<string, string>) {
  process.env.MIGRATIONS_DIR = DIR;
  vi.mocked(existsSync).mockImplementation((p) => String(p) === DIR);
  vi.mocked(readdir).mockResolvedValue(Object.keys(contents) as never);
  vi.mocked(readFile).mockImplementation(async (p) => {
    const name = String(p).split("/").pop()!;
    if (!(name in contents)) throw new Error(`ENOENT ${name}`);
    return contents[name];
  });
}

type QueryCall = { sql: string; values?: unknown[] };

/**
 * A stand-in for `pg.Client`. `ledger` = null means the schema_migrations table
 * doesn't exist (the pre-bootstrap state); `failOn` makes one statement throw so
 * the rollback path can be exercised.
 */
function mockPg(opts: { ledger: LedgerRow[] | null; failOn?: RegExp }) {
  const calls: QueryCall[] = [];
  let ledger = opts.ledger;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (opts.failOn?.test(sql)) throw new Error("syntax error at or near \"oops\"");
    if (/to_regclass/.test(sql)) return { rows: [{ reg: ledger === null ? null : "schema_migrations" }] };
    if (/^select filename/.test(sql)) return { rows: (ledger ?? []) as unknown as Record<string, unknown>[] };
    if (/^insert into schema_migrations/.test(sql)) {
      const [filename, checksum, applied_by] = (values ?? []) as [string, string, string];
      ledger = [
        ...(ledger ?? []).filter((r) => r.filename !== filename),
        { filename, checksum, applied_at: "2026-08-24T12:00:00.000Z", applied_by },
      ].sort((a, b) => a.filename.localeCompare(b.filename));
      return { rows: [] };
    }
    // The migration body itself (bootstrap) brings the table into existence.
    if (ledger === null && !/^(begin|commit|rollback)$/.test(sql)) ledger = [];
    return { rows: [] };
  });
  const client = { connect: vi.fn(async () => {}), query, end: vi.fn(async () => {}) };
  // Must be a `function`, not an arrow — the code under test calls `new Client(...)`.
  vi.mocked(Client).mockImplementation(function () {
    return client;
  } as never);
  return { client, calls, sqlOf: () => calls.map((c) => c.sql) };
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(existsSync).mockReturnValue(false);
  delete process.env.SUPABASE_DB_URL;
  delete process.env.MIGRATIONS_DIR;
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

// ── pure helpers ────────────────────────────────────────────

describe("filename validation + ordering", () => {
  it("accepts NNN_lower_snake.sql and reads the number", () => {
    expect(migrationNumber("001_initial_schema.sql")).toBe(1);
    expect(migrationNumber("043_schema_migrations.sql")).toBe(43);
  });

  it("rejects anything that isn't a migration filename", () => {
    for (const bad of [
      "1_initial.sql",            // not three digits
      "0043_thing.sql",           // four digits
      "043-schema-migrations.sql", // dashes
      "043_Schema_Migrations.sql", // uppercase
      "043_schema_migrations.txt", // wrong extension
      "043_.sql",                  // empty name
      "README.md",
      ".DS_Store",
    ]) {
      expect(migrationNumber(bad), bad).toBeNull();
    }
  });

  it("orders numerically, not lexicographically, and quarantines the rest", () => {
    const { valid, ignored } = sortMigrationFilenames([
      "010_ten.sql",
      "README.md",
      "002_two.sql",
      "1000_thousand.sql", // four digits — not a migration by our rule
      "009_nine.sql",
    ]);
    expect(valid).toEqual(["002_two.sql", "009_nine.sql", "010_ten.sql"]);
    expect(ignored).toEqual(["1000_thousand.sql", "README.md"]);
  });

  it("hashes file contents with sha256", () => {
    // Known vector: sha256("") — proves we're hashing the bytes, not the name.
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

describe("pending / drift / orphans", () => {
  const files = [f("001_a.sql"), f("002_b.sql"), f("003_c.sql")];

  it("pending is files minus ledger rows, in order", () => {
    expect(computePending(files, [row("001_a.sql")]).map((x) => x.filename)).toEqual([
      "002_b.sql",
      "003_c.sql",
    ]);
  });

  it("pending is empty when everything is recorded", () => {
    expect(computePending(files, files.map((x) => row(x.filename)))).toEqual([]);
  });

  it("flags a ledger row whose stored checksum no longer matches the file", () => {
    const drift = detectDrift(files, [row("002_b.sql", "an-old-hash", "ops@regenhub.xyz")]);
    expect(drift).toEqual([{ filename: "002_b.sql", stored: "an-old-hash", current: "sum-002_b.sql" }]);
  });

  it("does NOT flag baseline rows, whose checksum is null by design", () => {
    expect(detectDrift(files, [row("002_b.sql", null)])).toEqual([]);
  });

  it("does not flag a matching checksum", () => {
    expect(detectDrift(files, [row("002_b.sql", "sum-002_b.sql")])).toEqual([]);
  });

  it("reports ledger rows with no file on disk", () => {
    expect(detectOrphans(files, [row("001_a.sql"), row("099_gone.sql")]).map((r) => r.filename)).toEqual([
      "099_gone.sql",
    ]);
  });
});

describe("checkApplyAllowed", () => {
  const files = [f("001_a.sql"), f("042_b.sql"), f(LEDGER_MIGRATION), f("044_d.sql")];
  const allButLast = files.slice(0, 3).map((x) => row(x.filename));

  it("allows the lowest-numbered pending migration", () => {
    expect(checkApplyAllowed({ filename: "044_d.sql", files, applied: allButLast, ledgerExists: true }))
      .toEqual({ ok: true, bootstrap: false });
  });

  it("refuses a higher-numbered migration while a lower one is pending", () => {
    const applied = [row("001_a.sql")];
    const res = checkApplyAllowed({ filename: "044_d.sql", files, applied, ledgerExists: true });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/Out of order: 042_b\.sql is pending/);
  });

  it("refuses a migration that was already applied", () => {
    const res = checkApplyAllowed({ filename: "001_a.sql", files, applied: allButLast, ledgerExists: true });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/already applied/);
  });

  it("refuses a file that isn't in this deployment's directory", () => {
    const res = checkApplyAllowed({ filename: "099_future.sql", files, applied: allButLast, ledgerExists: true });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/not in the migrations directory/);
  });

  it("refuses a string that isn't a migration filename at all", () => {
    const res = checkApplyAllowed({ filename: "drop table members", files, applied: [], ledgerExists: true });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/not a migration filename/);
  });

  describe("bootstrap (no ledger table)", () => {
    it("permits 043 and marks it as the bootstrap", () => {
      expect(checkApplyAllowed({ filename: LEDGER_MIGRATION, files, applied: [], ledgerExists: false }))
        .toEqual({ ok: true, bootstrap: true });
    });

    it("refuses every other file — including 001, which would otherwise be 'lowest pending'", () => {
      for (const name of ["001_a.sql", "042_b.sql", "044_d.sql"]) {
        const res = checkApplyAllowed({ filename: name, files, applied: [], ledgerExists: false });
        expect(res.ok, name).toBe(false);
        expect(res.ok === false && res.reason).toMatch(/ledger doesn't exist yet/);
      }
    });
  });
});

// ── directory resolution ────────────────────────────────────

describe("resolveMigrationsDir", () => {
  it("prefers MIGRATIONS_DIR over everything else", () => {
    process.env.MIGRATIONS_DIR = "/custom/migrations";
    expect(migrationsDirCandidates("/app/apps/web")[0]).toBe("/custom/migrations");
  });

  it("covers both the container cwd and the double-nested standalone cwd", () => {
    // Dockerfile copies to /app/apps/web/supabase/migrations; server.js may chdir
    // into /app/apps/web/apps/web. One list has to find it from either.
    expect(migrationsDirCandidates("/app/apps/web")).toContain("/app/apps/web/supabase/migrations");
    expect(migrationsDirCandidates("/app/apps/web/apps/web")).toContain("/app/apps/web/supabase/migrations");
  });

  it("finds the repo root from a dev cwd of apps/web", () => {
    expect(migrationsDirCandidates("/repo/apps/web")).toContain("/repo/supabase/migrations");
  });

  it("returns the first candidate that exists", () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === "/repo/supabase/migrations");
    expect(resolveMigrationsDir("/repo/apps/web")).toBe("/repo/supabase/migrations");
  });

  it("returns null when nothing exists", () => {
    expect(resolveMigrationsDir("/nowhere")).toBeNull();
  });
});

describe("readMigrationFiles", () => {
  it("hashes each file and returns them in numeric order", async () => {
    mockDir({ "002_b.sql": "select 2;", "001_a.sql": "select 1;", "notes.md": "hi" });
    const { files, ignored } = await readMigrationFiles(DIR);
    expect(files.map((x) => x.filename)).toEqual(["001_a.sql", "002_b.sql"]);
    expect(files[0].checksum).toBe(sha256Hex("select 1;"));
    expect(files[0].number).toBe(1);
    expect(ignored).toEqual(["notes.md"]);
  });
});

// ── configuration + status ──────────────────────────────────

describe("isMigrationsConfigured", () => {
  it("is false without SUPABASE_DB_URL and true with it", () => {
    expect(isMigrationsConfigured()).toBe(false);
    process.env.SUPABASE_DB_URL = "postgres://u:p@h:5432/postgres";
    expect(isMigrationsConfigured()).toBe(true);
  });
});

describe("getMigrationStatus", () => {
  it("still lists files, and never touches pg, when SUPABASE_DB_URL is unset", async () => {
    mockDir({ "001_a.sql": "select 1;" });
    const status = await getMigrationStatus();
    expect(status.configured).toBe(false);
    expect(status.files.map((x) => x.filename)).toEqual(["001_a.sql"]);
    expect(status.applied).toEqual([]);
    expect(Client).not.toHaveBeenCalled();
  });

  it("reports every file as pending when the ledger table doesn't exist", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    mockDir({ "001_a.sql": "select 1;", [LEDGER_MIGRATION]: "create table schema_migrations();" });
    mockPg({ ledger: null });

    const status = await getMigrationStatus();
    expect(status.ledgerExists).toBe(false);
    expect(status.pending.map((x) => x.filename)).toEqual(["001_a.sql", LEDGER_MIGRATION]);
  });

  it("splits applied vs pending and surfaces drift", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    mockDir({ "001_a.sql": "select 1;", "002_b.sql": "select 2;", "003_c.sql": "select 3;" });
    const pg = mockPg({
      ledger: [row("001_a.sql", null), row("002_b.sql", "stale-hash", "ops@regenhub.xyz")],
    });

    const status = await getMigrationStatus();
    expect(status.applied.map((r) => r.filename)).toEqual(["001_a.sql", "002_b.sql"]);
    expect(status.pending.map((x) => x.filename)).toEqual(["003_c.sql"]);
    expect(status.drift).toEqual([
      { filename: "002_b.sql", stored: "stale-hash", current: sha256Hex("select 2;") },
    ]);
    expect(pg.client.end).toHaveBeenCalled();
  });
});

// ── applying ────────────────────────────────────────────────

describe("applyMigration", () => {
  it("refuses immediately when SUPABASE_DB_URL is unset", async () => {
    const res = await applyMigration("001_a.sql", "ops@regenhub.xyz");
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/SUPABASE_DB_URL is unset/) });
    expect(Client).not.toHaveBeenCalled();
  });

  it("runs the file and the ledger insert in one transaction", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    mockDir({ "001_a.sql": "select 1;", "002_b.sql": "alter table members add column x text;" });
    const pg = mockPg({ ledger: [row("001_a.sql", null)] });

    const res = await applyMigration("002_b.sql", "ops@regenhub.xyz");
    expect(res.ok).toBe(true);

    const sql = pg.sqlOf();
    const begin = sql.indexOf("begin");
    const body = sql.indexOf("alter table members add column x text;");
    const insert = sql.findIndex((s) => s.startsWith("insert into schema_migrations"));
    const commit = sql.indexOf("commit");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThan(begin);
    expect(insert).toBeGreaterThan(body);
    expect(commit).toBeGreaterThan(insert);
    expect(sql).not.toContain("rollback");
  });

  it("records the caller's email and the real checksum", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    mockDir({ "001_a.sql": "select 1;" });
    const pg = mockPg({ ledger: [] });

    const res = await applyMigration("001_a.sql", "ops@regenhub.xyz");
    expect(res.ok && res.checksum).toBe(sha256Hex("select 1;"));
    const insert = pg.calls.find((c) => c.sql.startsWith("insert into schema_migrations"))!;
    expect(insert.values).toEqual(["001_a.sql", sha256Hex("select 1;"), "ops@regenhub.xyz"]);
    expect(res.ok && res.status.pending).toEqual([]);
    expect(res.ok && res.status.applied.map((r) => r.applied_by)).toEqual(["ops@regenhub.xyz"]);
  });

  it("rolls back and applies nothing when the SQL fails", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    mockDir({ "001_a.sql": "oops not sql;" });
    const pg = mockPg({ ledger: [], failOn: /oops/ });

    const res = await applyMigration("001_a.sql", "ops@regenhub.xyz");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/rolled back — nothing was applied/);
    expect(pg.sqlOf()).toContain("rollback");
    expect(pg.sqlOf().some((s) => s.startsWith("insert into schema_migrations"))).toBe(false);
  });

  it("refuses out-of-order without opening a transaction", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    mockDir({ "001_a.sql": "select 1;", "002_b.sql": "select 2;" });
    const pg = mockPg({ ledger: [] });

    const res = await applyMigration("002_b.sql", "ops@regenhub.xyz");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/Out of order: 001_a\.sql/);
    expect(pg.sqlOf()).not.toContain("begin");
  });

  it("bootstraps: with no ledger table, 043 runs and only 043", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    mockDir({
      "001_a.sql": "select 1;",
      "042_b.sql": "select 42;",
      [LEDGER_MIGRATION]: "create table schema_migrations (filename text primary key);",
    });
    mockPg({ ledger: null });

    const blocked = await applyMigration("001_a.sql", "ops@regenhub.xyz");
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.error).toMatch(/ledger doesn't exist yet/);

    mockPg({ ledger: null });
    const res = await applyMigration(LEDGER_MIGRATION, "ops@regenhub.xyz");
    expect(res.ok).toBe(true);
    expect(res.ok && res.bootstrap).toBe(true);
    // The ledger now exists and knows about itself.
    expect(res.ok && res.status.applied.map((r) => r.filename)).toEqual([LEDGER_MIGRATION]);
  });

  it("refuses a filename that isn't in the deployed directory", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    mockDir({ "001_a.sql": "select 1;" });
    const pg = mockPg({ ledger: [] });

    const res = await applyMigration("099_not_shipped.sql", "ops@regenhub.xyz");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/not in the migrations directory/);
    expect(pg.sqlOf()).not.toContain("begin");
  });

  it("aborts if the file changes between hashing and reading", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    mockDir({ "001_a.sql": "select 1;" });
    mockPg({ ledger: [] });
    // First read (hashing) sees one thing, the apply-time read sees another.
    let n = 0;
    vi.mocked(readFile).mockImplementation(async () => (n++ === 0 ? "select 1;" : "select 2;"));

    const res = await applyMigration("001_a.sql", "ops@regenhub.xyz");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/changed on disk/);
  });
});
