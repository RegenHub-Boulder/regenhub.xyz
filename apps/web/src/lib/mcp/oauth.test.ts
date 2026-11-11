import { createHash } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { makePgDb, type PgDb } from "../../../test/pgDb";

// Token verification against a real Postgres with every migration applied.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));

import { createServiceClient } from "@/lib/supabase/admin";
import { verifyAccessToken } from "./oauth";

let db: PgDb;
afterAll(async () => { await db?.close(); });

it("an ops admin's token stops working the moment they're disabled or demoted", async () => {
  db = await makePgDb();
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  await db.sql("insert into members (id, name, email, is_admin, is_ops_admin, member_type) values (1, 'Ada', 'ada@example.test', true, true, 'day_pass')");
  await db.sql("insert into mcp_oauth_clients (client_id, redirect_uris) values ('c', array['http://localhost/cb'])");
  await db.sql(`insert into mcp_oauth_tokens (token_hash, kind, client_id, member_id, scopes, expires_at)
    values ($1, 'access', 'c', 1, array['read'], now() + interval '1 hour')`, [createHash("sha256").update("tok").digest("hex")]);

  expect(await verifyAccessToken("tok")).toMatchObject({ extra: { memberId: 1, isOpsAdmin: true } });
  await db.sql("update members set disabled = true where id = 1");
  expect(await verifyAccessToken("tok")).toBeNull();
  await db.sql("update members set disabled = false, is_ops_admin = false where id = 1");
  expect(await verifyAccessToken("tok")).toBeNull();
});
