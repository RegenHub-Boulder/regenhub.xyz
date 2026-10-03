import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("migration is idempotent and enforces reservation, quarantine and service-only grants", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table members(id integer primary key, pin_code_slot integer, pin_code text, disabled boolean default false, member_type text);
      create table day_codes(id integer primary key,pin_slot integer,code text,is_active boolean default true);
      insert into members values(1,1,'1234',false,'hot_desk');
      insert into day_codes values(1,101,'1234',true);`);
    const migration = await readFile(new URL("../../../../supabase/migrations/053_lock_slot_quarantine.sql", import.meta.url), "utf8");
    await pg.exec(migration); await pg.exec(migration);
    const visibility = await readFile(new URL("../../../../supabase/migrations/054_lock_writer_holder.sql", import.meta.url), "utf8");
    await pg.exec(visibility); await pg.exec(visibility);
    const token = "00000000-0000-4000-8000-000000000001";
    const other = "00000000-0000-4000-8000-000000000002";
    const query = async (sql: string, args: unknown[] = []) => (await pg.query(sql, args)).rows as Record<string, unknown>[];
    expect((await query("select acquire_lock_writer($1, 'Web PIN writer') ok", [token]))[0].ok).toBe(true);
    expect((await query("select acquire_lock_writer($1) ok", [other]))[0].ok).toBe(false);
    expect((await query("select holder_label from lock_slot_writer"))[0].holder_label).toBe("Web PIN writer");
    await expect(pg.exec("update members set pin_code='5678' where id=1")).rejects.toThrow(/requires PIN writer/);
    await pg.query("select set_config('request.headers',$1,false)", [JSON.stringify({ "x-lock-writer-token": token })]);
    await pg.exec("update members set pin_code='5678' where id=1");
    await pg.query("select quarantine_lock_slot($1,101,'partial', '[]')", [token]);
    await pg.exec("update day_codes set is_active=false where id=1");
    await expect(pg.exec("insert into day_codes values(2,101,'9876',true)")).rejects.toThrow(/quarantined/);
    expect((await query("select count(*)::integer n from lock_slot_quarantine"))[0].n).toBe(1);
    await pg.query("select release_lock_quarantine($1,101)", [token]);
    await pg.exec("insert into day_codes values(2,101,'9876',true)");
    await pg.exec("delete from members where id=1");
    expect((await query("select reason from lock_slot_quarantine where slot=1"))[0].reason)
      .toBe("Ownership released without confirmed all-door clear");
    await pg.exec("set role authenticated");
    await expect(pg.exec("select * from lock_slot_quarantine")).rejects.toThrow(/permission denied/);
    await expect(pg.query("select acquire_lock_writer($1)", [other])).rejects.toThrow(/permission denied/);
    await pg.exec("reset role; set role anon");
    await expect(pg.exec("select * from lock_slot_writer")).rejects.toThrow(/permission denied/);
    await pg.exec("reset role; set role service_role");
    expect((await query("select count(*)::integer n from lock_slot_quarantine"))[0].n).toBe(1);
    await expect(pg.exec("delete from lock_slot_quarantine")).rejects.toThrow(/permission denied/);
    await pg.query("select release_lock_writer($1)", [token]);
    await pg.exec("reset role");
    expect((await query("select count(*)::integer n from lock_slot_writer"))[0].n).toBe(0);
  } finally { await pg.close(); }
}, 20_000);
