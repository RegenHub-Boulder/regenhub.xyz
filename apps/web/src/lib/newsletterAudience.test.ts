import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "../../test/pglitePostgrest";
import { compileAudience } from "./newsletter";

// The real supabase-js client and the real queries, against PGlite through the PostgREST stand-in.
let pg: PGlite;
const client = () =>
  createClient("http://127.0.0.1:1", "service", { global: { fetch: pglitePostgrest(pg, new Map()) as typeof fetch } }) as never;

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`
    create table members (id serial primary key, name text, email text, member_type text, disabled boolean not null default false);
    create table interests (id serial primary key, name text, email text);
    create table email_unsubscribes (email text primary key);
    insert into members (name, email, disabled) values ('A', 'a@example.test', false), ('B', 'b@example.test', true),
      ('C', 'C@example.test', false);
    insert into interests (name, email) values (null, 'c@example.test'), ('D', 'd@example.test'), ('E', 'e@example.test');
    insert into email_unsubscribes values ('E@example.test');`);
});

describe("compileAudience", () => {
  it("members and stay-in-touch signups, once each, minus disabled members and unsubscribes", async () => {
    expect(await compileAudience(client())).toEqual([
      { email: "a@example.test", name: "A" },
      { email: "C@example.test", name: "C" },
      { email: "d@example.test", name: "D" },
    ]);
  });

  it("throws when the unsubscribe list can't be read, rather than mail people who left", async () => {
    await pg.exec("drop table email_unsubscribes");
    await expect(compileAudience(client())).rejects.toThrow(/email_unsubscribes/);
  });
});
