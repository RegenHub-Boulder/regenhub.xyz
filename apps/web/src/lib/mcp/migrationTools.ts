import type { McpAuthInfo } from "./oauth";
import { hasScope } from "./metadata";
import {
  applyMigration,
  getMigrationStatus,
  isMigrationsConfigured,
  LEDGER_MIGRATION,
  NOT_CONFIGURED,
  type MigrationStatus,
} from "@/lib/migrations";

/**
 * The `list_migrations` / `run_migration` MCP tools.
 *
 * Kept out of server.ts so the handlers can be unit-tested directly — server.ts
 * just registers them. Both are gated on the `migrate` scope; both report
 * "not configured" rather than throwing when SUPABASE_DB_URL is unset, so a
 * deployment without database access still serves the rest of the MCP.
 */

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const fail = (s: string): ToolResult => ({ isError: true, content: [{ type: "text", text: s }] });

const denied = (tool: string) =>
  fail(`Denied: ${tool} requires the "migrate" scope, which this token doesn't carry. Reconnect the MCP to re-consent.`);

/** Render the drift + orphan warnings that must never be quiet. */
function warnings(status: MigrationStatus): string[] {
  const lines: string[] = [];
  for (const d of status.drift) {
    lines.push(
      `⚠️  DRIFT: ${d.filename} was applied as ${d.stored.slice(0, 12)}… but the file on disk now hashes to ${d.current.slice(0, 12)}…. ` +
        `Someone edited a migration after it ran. Nothing here will fix that automatically — reconcile by hand.`,
    );
  }
  for (const o of status.orphans) {
    lines.push(`⚠️  ORPHAN: the ledger says ${o.filename} was applied (${o.applied_at}) but there is no such file on disk.`);
  }
  for (const i of status.ignored) {
    lines.push(`ℹ️  Ignored (doesn't match NNN_name.sql): ${i}`);
  }
  return lines;
}

function renderStatus(status: MigrationStatus): string {
  const lines: string[] = [];

  if (!status.configured) {
    lines.push(`## Migrations: NOT CONFIGURED`);
    lines.push(NOT_CONFIGURED);
    lines.push("");
    lines.push(`Files on disk (${status.files.length}) — applied state unknown:`);
    for (const f of status.files) lines.push(`- ${f.filename}`);
    return lines.join("\n");
  }

  lines.push(`## Migrations (SUPABASE_DB_URL configured · dir: ${status.dir ?? "NOT FOUND"})`);

  if (!status.dir) {
    lines.push("");
    lines.push("No supabase/migrations directory was found on this deployment — is the image built from a Dockerfile that copies it? Set MIGRATIONS_DIR to override.");
  }

  if (!status.ledgerExists) {
    lines.push("");
    lines.push(
      `**The \`schema_migrations\` ledger does not exist yet.** Nothing has been recorded. ` +
        `Bootstrap it with \`run_migration("${LEDGER_MIGRATION}")\` — that file creates the ledger and seeds every migration through 043 as already-applied.`,
    );
  }

  lines.push("");
  lines.push(`### Applied (${status.applied.length})`);
  if (status.applied.length === 0) {
    lines.push("_(none recorded)_");
  } else {
    lines.push("| filename | applied_at | applied_by |");
    lines.push("|---|---|---|");
    for (const r of status.applied) {
      lines.push(`| ${r.filename} | ${r.applied_at} | ${r.applied_by ?? "—"} |`);
    }
  }

  lines.push("");
  lines.push(`### Pending (${status.pending.length})`);
  if (status.pending.length === 0) {
    lines.push("_(none — the database is up to date with this deployment's files)_");
  } else {
    status.pending.forEach((f, i) => {
      lines.push(`- ${f.filename}${i === 0 ? "  ← next; only this one may run" : ""}`);
    });
  }

  const w = warnings(status);
  if (w.length > 0) {
    lines.push("");
    lines.push("### Warnings");
    lines.push(...w);
  }

  return lines.join("\n");
}

/** `list_migrations` — read-only, always safe to call. */
export async function listMigrationsHandler(auth: McpAuthInfo): Promise<ToolResult> {
  if (!hasScope(auth.scopes, "migrate")) return denied("list_migrations");
  try {
    return text(renderStatus(await getMigrationStatus()));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Could not read migration state: ${msg}`);
  }
}

/** `run_migration` — applies exactly the named file, if it's the one that's allowed to run. */
export async function runMigrationHandler(auth: McpAuthInfo, filename: string): Promise<ToolResult> {
  if (!hasScope(auth.scopes, "migrate")) return denied("run_migration");
  if (!isMigrationsConfigured()) return fail(NOT_CONFIGURED);

  const appliedBy = auth.extra.email || `member ${auth.extra.memberId}`;
  let result;
  try {
    result = await applyMigration(filename, appliedBy);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Could not apply ${filename}: ${msg}`);
  }
  if (!result.ok) return fail(result.error);

  const head = result.bootstrap
    ? `Bootstrapped the ledger: applied **${result.filename}** as ${appliedBy}.`
    : `Applied **${result.filename}** as ${appliedBy}.`;
  return text(`${head}\nchecksum ${result.checksum}\n\n${renderStatus(result.status)}`);
}

export const LIST_MIGRATIONS_DESCRIPTION =
  "Read-only status of the database migrations in supabase/migrations/ against the schema_migrations ledger on the " +
  "production database. Shows what's applied (filename, when, by whom), what's pending, any checksum drift " +
  "(a migration file edited after it ran), and whether SUPABASE_DB_URL is configured on this deployment. " +
  "Always safe to call — it never writes. Call it before and after run_migration.";

export const RUN_MIGRATION_DESCRIPTION =
  "APPLIES A SQL MIGRATION to the production database, inside a single transaction, and records it in the " +
  "schema_migrations ledger. You must name the exact file (e.g. '044_add_thing.sql') — there is deliberately no " +
  "'run all'. It will only run the LOWEST-numbered pending migration; anything else is refused. If the ledger " +
  `table doesn't exist yet, the only permitted file is '${LEDGER_MIGRATION}', which creates and seeds it. ` +
  "The migration must be present in the deployed image, so ship the code first, then run this. Use list_migrations to see what's pending.";
