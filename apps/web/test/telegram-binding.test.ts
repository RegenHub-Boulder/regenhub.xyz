import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makePgDb, type PgDb } from "./pgDb";

/**
 * The bot's Telegram sender checks (apps/bot/src/db/supabase.ts) against a real
 * Postgres with every migration applied, 061 included. The bot runs its real
 * queries; only the Supabase client is swapped for the PGlite stand-in.
 */
type Bot = typeof import("../../bot/src/db/supabase");
let bot: Bot;
let db: PgDb;

beforeAll(async () => {
  // The bot module builds its service client at import; it is never used here.
  process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "unused";
  bot = await import("../../bot/src/db/supabase");
}, 60_000);

beforeEach(async () => {
  db = await makePgDb();
  await db.sql(`insert into members (id, name, member_type, telegram_username, is_admin, disabled) values
    (1, 'Ada Admin', 'hot_desk', 'ada', true, false),
    (2, 'Bea Member', 'cold_desk', 'bea', false, false),
    (3, 'Cy Gone', 'hot_desk', 'cy', false, true)`);
}, 60_000);

const client = () => ({ client: db as never });
const resolve = (id: number | undefined, username: string) => bot.resolveSender({ id, username }, client());
const boundId = async (memberId: number) =>
  (await db.sql<{ telegram_user_id: number | null }>("select telegram_user_id from members where id = $1", [memberId]))[0].telegram_user_id;

describe("resolveSender", () => {
  it("binds an unbound member to the sender's id on first contact", async () => {
    expect((await resolve(1001, "bea"))?.id).toBe(2);
    expect(await boundId(2)).toBe(1001);
  });

  it("refuses a recycled handle: same @username, different Telegram id", async () => {
    await resolve(1001, "bea");
    expect(await resolve(6666, "bea")).toBeNull();
    expect(await resolve(6666, "@BEA")).toBeNull();
    expect(await boundId(2)).toBe(1001);
  });

  it("follows the id when the member renames their handle in Telegram", async () => {
    await resolve(1001, "bea");
    expect((await resolve(1001, "bea_renamed"))?.id).toBe(2);
  });

  it("refuses a sender without an id, and a disabled member", async () => {
    expect(await resolve(undefined, "bea")).toBeNull();
    expect(await boundId(2)).toBeNull();
    expect(await resolve(3003, "cy")).toBeNull();
  });

  it("lets exactly one of two racing senders bind the same handle", async () => {
    const [a, b] = await Promise.all([resolve(1001, "bea"), resolve(6666, "bea")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await boundId(2)).toBe(a ? 1001 : 6666);
  });

  it("falls back to @username alone while 061 isn't applied", async () => {
    await db.exec("alter table members drop column telegram_user_id cascade");
    expect((await resolve(1001, "bea"))?.id).toBe(2);
    expect((await resolve(6666, "bea"))?.id).toBe(2);
  });
});

describe("resolveAdminSender", () => {
  it("gives admin commands (door holds included) to the bound admin only", async () => {
    expect((await bot.resolveAdminSender({ id: 1000, username: "ada" }, client()))?.id).toBe(1);
    expect(await bot.resolveAdminSender({ id: 6666, username: "ada" }, client())).toBeNull();
    expect(await bot.resolveAdminSender({ id: 1001, username: "bea" }, client())).toBeNull();
  });
});

describe("061_telegram_user_id.sql", () => {
  it("drops the binding when the member is pointed at a different handle", async () => {
    await resolve(1001, "bea");
    await db.from("members").update({ telegram_username: "someone_else" }).eq("id", 2);
    expect(await boundId(2)).toBeNull();
  });

  it("keeps the binding when the same handle is re-saved in another form", async () => {
    await resolve(1001, "bea");
    await db.from("members").update({ telegram_username: "@BEA" }).eq("id", 2);
    await db.from("members").update({ telegram_username: " Bea " }).eq("id", 2);
    expect(await boundId(2)).toBe(1001);
  });

  it("allows one member per Telegram id", async () => {
    await resolve(1001, "bea");
    await expect(db.sql("update members set telegram_user_id = 1001 where id = 1")).rejects.toThrow(/unique/);
  });

  it("never lets a signed-in member write their own binding, even if a self-update policy comes back", async () => {
    await resolve(1001, "bea");
    // What 031 closed: table UPDATE for authenticated plus 003's open self-update policy.
    await db.exec(`grant select, update on members to authenticated;
      create policy rh_reopened_select on members for select to authenticated using (true);
      create policy rh_reopened_update on members for update to authenticated using (true);`);
    await db.exec(`begin; set local role authenticated;
      update members set telegram_user_id = 6666, bio = 'edited as authenticated' where id = 2; commit;`);
    const [row] = await db.sql<{ bio: string | null }>("select bio from members where id = 2");
    expect(row.bio).toBe("edited as authenticated"); // the write really ran as authenticated
    expect(await boundId(2)).toBe(1001);
  });
});
