import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/migrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/migrations")>();
  return {
    ...actual,
    getMigrationStatus: vi.fn(),
    applyMigration: vi.fn(),
  };
});

import { listMigrationsHandler, runMigrationHandler } from "./migrationTools";
import {
  applyMigration,
  getMigrationStatus,
  LEDGER_MIGRATION,
  type MigrationStatus,
} from "@/lib/migrations";
import type { McpAuthInfo } from "./oauth";

const auth = (scopes: string[]): McpAuthInfo => ({
  token: "t",
  clientId: "c",
  scopes,
  extra: { memberId: 7, email: "ops@regenhub.xyz", isAdmin: true, isOpsAdmin: true },
});

const status = (over: Partial<MigrationStatus> = {}): MigrationStatus => ({
  configured: true,
  dir: "/app/apps/web/supabase/migrations",
  files: [],
  ignored: [],
  ledgerExists: true,
  applied: [],
  pending: [],
  drift: [],
  orphans: [],
  ...over,
});

const body = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

const OLD_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SUPABASE_DB_URL;
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe("scope gating", () => {
  it("denies both tools when the token has scopes but not `migrate`", async () => {
    const a = auth(["read", "locks"]);

    const list = await listMigrationsHandler(a);
    expect(list.isError).toBe(true);
    expect(body(list)).toMatch(/requires the "migrate" scope/);
    expect(getMigrationStatus).not.toHaveBeenCalled();

    const run = await runMigrationHandler(a, "044_x.sql");
    expect(run.isError).toBe(true);
    expect(body(run)).toMatch(/requires the "migrate" scope/);
    expect(applyMigration).not.toHaveBeenCalled();
  });

  it("allows a token that carries `migrate`", async () => {
    vi.mocked(getMigrationStatus).mockResolvedValue(status());
    const list = await listMigrationsHandler(auth(["read", "migrate"]));
    expect(list.isError).toBeUndefined();
    expect(getMigrationStatus).toHaveBeenCalled();
  });

  it("allows a legacy token with NO scopes at all — an unscoped grant is a full one", async () => {
    // Every token minted before scopes were enforced has scopes: []. Entry is
    // already is_ops_admin-gated, so those must keep working.
    vi.mocked(getMigrationStatus).mockResolvedValue(status());
    const list = await listMigrationsHandler(auth([]));
    expect(list.isError).toBeUndefined();
  });
});

describe("list_migrations", () => {
  it("says so, plainly, when SUPABASE_DB_URL is unset — and still lists the files", async () => {
    vi.mocked(getMigrationStatus).mockResolvedValue(
      status({
        configured: false,
        ledgerExists: false,
        files: [{ filename: "001_a.sql", number: 1, checksum: "abc" }],
      }),
    );
    const res = await listMigrationsHandler(auth(["migrate"]));
    expect(res.isError).toBeUndefined(); // not configured is a state, not a failure
    expect(body(res)).toMatch(/NOT CONFIGURED/);
    expect(body(res)).toMatch(/SUPABASE_DB_URL is unset/);
    expect(body(res)).toMatch(/001_a\.sql/);
  });

  it("points at the bootstrap when the ledger table doesn't exist", async () => {
    vi.mocked(getMigrationStatus).mockResolvedValue(
      status({ ledgerExists: false, pending: [{ filename: LEDGER_MIGRATION, number: 43, checksum: "x" }] }),
    );
    const res = await listMigrationsHandler(auth(["migrate"]));
    expect(body(res)).toMatch(/ledger.* does not exist yet/);
    expect(body(res)).toContain(`run_migration("${LEDGER_MIGRATION}")`);
  });

  it("tables the applied rows, marks the next pending one, and shouts about drift", async () => {
    vi.mocked(getMigrationStatus).mockResolvedValue(
      status({
        applied: [
          { filename: "001_a.sql", checksum: null, applied_at: "2026-01-01T00:00:00Z", applied_by: "baseline" },
          { filename: "002_b.sql", checksum: "0123456789abcdef", applied_at: "2026-02-02T00:00:00Z", applied_by: "ops@regenhub.xyz" },
        ],
        pending: [
          { filename: "044_c.sql", number: 44, checksum: "y" },
          { filename: "045_d.sql", number: 45, checksum: "z" },
        ],
        drift: [{ filename: "002_b.sql", stored: "0123456789abcdef", current: "fedcba9876543210" }],
        orphans: [{ filename: "099_gone.sql", checksum: null, applied_at: "2026-03-03T00:00:00Z", applied_by: "manual" }],
      }),
    );
    const out = body(await listMigrationsHandler(auth(["migrate"])));
    expect(out).toMatch(/### Applied \(2\)/);
    expect(out).toMatch(/\| 001_a\.sql \| 2026-01-01T00:00:00Z \| baseline \|/);
    expect(out).toMatch(/### Pending \(2\)/);
    expect(out).toMatch(/- 044_c\.sql {2}← next; only this one may run/);
    expect(out).not.toMatch(/045_d\.sql {2}←/);
    expect(out).toMatch(/DRIFT: 002_b\.sql/);
    expect(out).toMatch(/ORPHAN: the ledger says 099_gone\.sql/);
  });

  it("turns an unexpected failure into an error result, not a crash", async () => {
    vi.mocked(getMigrationStatus).mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:5432"));
    const res = await listMigrationsHandler(auth(["migrate"]));
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/ECONNREFUSED/);
  });
});

describe("run_migration", () => {
  it("refuses without touching the database when SUPABASE_DB_URL is unset", async () => {
    const res = await runMigrationHandler(auth(["migrate"]), "044_c.sql");
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/SUPABASE_DB_URL is unset/);
    expect(applyMigration).not.toHaveBeenCalled();
  });

  it("records the caller's email as applied_by", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    vi.mocked(applyMigration).mockResolvedValue({
      ok: true, filename: "044_c.sql", checksum: "deadbeef", bootstrap: false,
      status: status({ applied: [{ filename: "044_c.sql", checksum: "deadbeef", applied_at: "now", applied_by: "ops@regenhub.xyz" }] }),
    });
    const res = await runMigrationHandler(auth(["migrate"]), "044_c.sql");
    expect(applyMigration).toHaveBeenCalledWith("044_c.sql", "ops@regenhub.xyz");
    expect(res.isError).toBeUndefined();
    expect(body(res)).toMatch(/Applied \*\*044_c\.sql\*\* as ops@regenhub\.xyz/);
    expect(body(res)).toMatch(/deadbeef/);
  });

  it("falls back to the member id when the token carries no email", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    vi.mocked(applyMigration).mockResolvedValue({ ok: false, error: "nope" });
    const a = { ...auth(["migrate"]), extra: { memberId: 7, email: "", isAdmin: true, isOpsAdmin: true } };
    await runMigrationHandler(a, "044_c.sql");
    expect(applyMigration).toHaveBeenCalledWith("044_c.sql", "member 7");
  });

  it("surfaces the library's refusal verbatim", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    vi.mocked(applyMigration).mockResolvedValue({ ok: false, error: "Out of order: 043_schema_migrations.sql is pending and comes first." });
    const res = await runMigrationHandler(auth(["migrate"]), "044_c.sql");
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/Out of order/);
  });

  it("names the bootstrap for what it is", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    vi.mocked(applyMigration).mockResolvedValue({
      ok: true, filename: LEDGER_MIGRATION, checksum: "c0ffee", bootstrap: true, status: status(),
    });
    const res = await runMigrationHandler(auth(["migrate"]), LEDGER_MIGRATION);
    expect(body(res)).toMatch(/Bootstrapped the ledger/);
  });

  it("turns a thrown driver error into an error result", async () => {
    process.env.SUPABASE_DB_URL = "postgres://x";
    vi.mocked(applyMigration).mockRejectedValue(new Error("password authentication failed"));
    const res = await runMigrationHandler(auth(["migrate"]), "044_c.sql");
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/password authentication failed/);
  });
});
