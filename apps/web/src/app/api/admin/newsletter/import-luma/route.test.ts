/**
 * Luma CSV → interests, through the real route against a real Postgres (PGlite, every migration applied).
 * Faked: who is signed in (requireAdmin). Sample data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePgDb, type PgDb } from "../../../../../../test/pgDb";

vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));

import { POST } from "./route";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";

// A Luma "People" export: BOM, the real column set, quoted names with commas, mixed case, a repeat.
const PEOPLE_CSV =
  "﻿name,first_name,last_name,email,subscription_status,first_seen,user_id,tags,revenue,event_approved_count,event_checked_in_count,membership_name,membership_status\r\n" +
  '"Rivera, Sam",Sam,Rivera,Sam.Rivera@Example.test,subscribed,2026-01-02,usr-1,,0,1,1,,\r\n' +
  "Kim Lee,Kim,Lee,kim@example.test,unsubscribed,2026-01-03,usr-2,,0,0,0,,\r\n" +
  "Not An Email,Not,Email,not-an-email,subscribed,2026-01-04,usr-3,,0,0,0,,\r\n" +
  "Sam again,Sam,Rivera,sam.rivera@example.test,subscribed,2026-01-05,usr-4,,0,0,0,,\r\n" +
  "Member Pat,Pat,Member,PAT@example.test,subscribed,2026-01-06,usr-5,,0,2,2,,\r\n" +
  "Interested Jo,Jo,I,jo@example.test,subscribed,2026-01-07,usr-6,,0,0,0,,\r\n" +
  "Left Us,Left,Us,left@example.test,subscribed,2026-01-08,usr-7,,0,0,0,,\r\n" +
  ",Ola,New,ola@example.test,subscribed,2026-01-09,usr-8,,0,0,0,,\r\n";

// An event's Guests export: no subscription_status, approval columns instead.
const GUESTS_CSV =
  "api_id,name,first_name,last_name,email,phone_number,created_at,approval_status,checked_in_at\n" +
  "gst-1,Taylor Guest,Taylor,Guest,taylor@example.test,,2026-11-01,approved,\n" +
  "gst-2,Kim Lee,Kim,Lee,kim@example.test,,2026-11-01,approved,\n" +
  "gst-3,Only Invited,Only,Invited,invited@example.test,,2026-11-01,invited,\n" +
  "gst-4,Host Declined,Host,Declined,declined@example.test,,2026-11-01,declined,\n" +
  "gst-5,On Waitlist,On,Waitlist,waitlist@example.test,,2026-11-01,waitlist,\n";

let db: PgDb;

const post = async (body: unknown) => {
  const res = await POST(new Request("http://site.test/api/admin/newsletter/import-luma", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};
const lumaRows = () => db.sql<{ email: string; name: string | null; source_path: string; interests: string[] }>(
  "select email, name, source_path, interests from interests where source_path = 'luma' order by id");

beforeEach(async () => {
  db = await makePgDb();
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  vi.mocked(requireAdmin).mockResolvedValue({ id: "admin-1", email: "admin@example.test" } as never);
  await db.sql("insert into members (name, email) values ('Pat', 'pat@example.test')");
  await db.sql("insert into interests (email, name, source_path) values ('Jo@Example.test', 'Jo', '/interest')");
  await db.sql("insert into email_unsubscribes (email, source) values ('left@example.test', 'link')");
});
afterEach(async () => {
  await db.close();
});

describe("POST /api/admin/newsletter/import-luma (Luma CSV)", () => {
  it("refuses anyone who isn't an admin, and writes nothing", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(null as never);
    expect((await post({ csv: PEOPLE_CSV, commit: true })).status).toBe(403);
    expect(await lumaRows()).toEqual([]);
  });

  it("dry run: counts new, already have and each skip, and writes nothing", async () => {
    const out = await post({ csv: PEOPLE_CSV });
    expect(out).toEqual({
      status: 200,
      body: { rows: 8, add: 2, alreadyHave: 2, unsubscribedHere: 1, unsubscribedOnLuma: 1, notRegistered: 0, invalid: 1, duplicate: 1 },
    });
    expect(await lumaRows()).toEqual([]);
  });

  it("import: adds only the new people, lowercased, as source 'luma'; a second run adds no one", async () => {
    const out = await post({ csv: PEOPLE_CSV, commit: true });
    expect(out.body).toMatchObject({ add: 2, imported: 2 });
    expect(await lumaRows()).toEqual([
      { email: "sam.rivera@example.test", name: "Rivera, Sam", source_path: "luma", interests: ["luma"] },
      { email: "ola@example.test", name: "Ola New", source_path: "luma", interests: ["luma"] },
    ]);
    const again = await post({ csv: PEOPLE_CSV, commit: true });
    expect(again.body).toMatchObject({ add: 0, alreadyHave: 4, imported: 0 });
    expect(await lumaRows()).toHaveLength(2);
  });

  it("an event guests export works too, leaving out people only invited or declined", async () => {
    const out = await post({ csv: GUESTS_CSV, commit: true });
    expect(out.body).toMatchObject({ rows: 5, add: 3, imported: 3, unsubscribedOnLuma: 0, notRegistered: 2 });
    expect((await lumaRows()).map((r) => r.email)).toEqual(["taylor@example.test", "kim@example.test", "waitlist@example.test"]);
  });

  it("a disabled member isn't in the audience, so a Luma subscriber who is one is added", async () => {
    await db.sql("insert into members (name, email, disabled) values ('Former', 'former@example.test', true)");
    const csv = "email,subscription_status\nformer@example.test,subscribed\n";
    expect((await post({ csv, commit: true })).body).toMatchObject({ add: 1, alreadyHave: 0, imported: 1 });
  });

  it("a file with no email column, or no file, is refused with a plain reason", async () => {
    expect(await post({ csv: "name,phone\nSam,555\n" })).toMatchObject({ status: 400, body: { error: expect.stringContaining("No email column") } });
    expect(await post({})).toMatchObject({ status: 400 });
  });

  it("an unreadable unsubscribe list stops the import (never re-adds people who left)", async () => {
    await db.exec("alter table email_unsubscribes rename to email_unsubscribes_gone");
    const out = await post({ csv: PEOPLE_CSV, commit: true });
    expect(out.status).toBe(503);
    expect(await lumaRows()).toEqual([]);
  });
});
