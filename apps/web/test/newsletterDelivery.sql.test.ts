/** Real Postgres transactions + mocked provider. Run ONLY via scripts/test-newsletter-local.sh. */
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sendBatch, prepareIssue, retryFailed, issueProgress } from "@/lib/newsletterSend";
import { sendEmailDetailed } from "@/lib/email";
import { compileIssue } from "@/lib/newsletter";
import { POST as cronPOST } from "@/app/api/cron/newsletter/route";
import type { createServiceClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({createServiceClient: () => admin}));
vi.mock("@/lib/newsletter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/newsletter")>();
  return {...actual, compileIssue: vi.fn()};
});
vi.mock("@/lib/email", () => ({ isEmailConfigured: () => true, sendEmailDetailed: vi.fn() }));
const url = process.env.NEWSLETTER_TEST_DATABASE_URL;
if (url && url !== "postgres://postgres@127.0.0.1:55497/postgres") {
  throw new Error("Refusing all database URLs except the explicitly authorized local test server");
}
const provider = vi.mocked(sendEmailDetailed);
const context = { siteUrl: "http://localhost:3000", from: "mock@example.invalid", replyTo: "mock@example.invalid", issueKey: "IGNORED" };
const schema = `newsletter_test_${process.pid}_${Date.now()}`;
let pool: Pool;
let issue: number;
const sql = (q: string, values?: unknown[]) => pool.query(q.replaceAll("SCHEMA", schema), values);
async function rpc<T>(name: string, args: Record<string, unknown>, client?: PoolClient): Promise<T> {
  const values = Object.values(args);
  const query = `select ${schema}.${name}(${values.map((_, j) => `$${j + 1}`).join(",")}) as value`;
  return (await (client ?? pool).query(query, values)).rows[0].value;
}
const admin = { rpc: async (name: string, args: Record<string, unknown>) => {
  try { return { data: await rpc(name, args), error: null }; }
  catch (error) { return { data: null, error: { message: (error as Error).message } }; }
}} as unknown as ReturnType<typeof createServiceClient>;
const claim = () => rpc<{ id: number; fence: number; snapshot: { subject: string; context: typeof context } } | null>("newsletter_claim", { p_issue: issue, p_context: context });
function payload(email = "one@example.invalid") { return {to: email, subject: "Original", from: context.from, replyTo: context.replyTo, html: "<p>original</p>", text: "original"}; }
function begin(c: {id: number; fence: number}, p = payload()) { return rpc("newsletter_begin", {p_issue:issue,p_send:c.id,p_fence:c.fence,p_payload:p}); }
function complete(c: {id: number; fence: number}, outcome: string, id: string | null = null) { return rpc("newsletter_complete", {p_issue:issue,p_send:c.id,p_fence:c.fence,p_outcome:outcome,p_provider_id:id}); }
async function seed() {
  issue = await rpc("newsletter_ensure_week", {p_key:"2026-W40",p_subject:"Original",p_html:"<p>original {{NEWSLETTER_UNSUBSCRIBE}}</p>",p_text:"original {{NEWSLETTER_UNSUBSCRIBE}}"});
  await sql("insert into SCHEMA.members(email,name,disabled) values('one@example.invalid','One',false)");
  await prepareIssue(admin, issue);
}
function deferred() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return {promise,release}; }

describe.skipIf(!url)("newsletter real SQL delivery", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 2000, options: `-c search_path=${schema}` });
    // Never drop or modify a pre-existing schema; every run owns its own schema.
    await pool.query(`create schema ${schema}`);
    await sql(`
      do $$ begin
        if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
        if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
        if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
      end $$;
      create function SCHEMA.auth_uid() returns uuid language sql as $$ select null::uuid $$;
      create function SCHEMA.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
      create table SCHEMA.members(id serial primary key,email text,name text,disabled boolean default false,supabase_user_id uuid,is_admin boolean);
      create table SCHEMA.interests(email text,name text);
      create table SCHEMA.digest_notes(id serial primary key,consumed_at timestamptz);
    `);
    const migration = (name: string) => readFileSync(resolve(process.cwd(), "../../supabase/migrations", name), "utf8")
      .replaceAll("public.", `${schema}.`).replaceAll("search_path = public,", `search_path = ${schema},`)
      .replaceAll("auth.uid()", `${schema}.auth_uid()`);
    await sql(`set search_path = ${schema};`);
    await sql(migration("035_newsletter.sql"));
    await sql(migration("039_newsletter_drafts_and_sends.sql"));
    await sql(`insert into SCHEMA.newsletter_issues(issue_key,subject,status) values ('legacy','Legacy','sending'),('old-draft','Draft','draft');
      insert into SCHEMA.newsletter_sends(issue_id,email,status) values (1,'pending@example.invalid','pending'),(1,'sent@example.invalid','sent'),(2,'failed@example.invalid','failed');`);
    await sql(migration("053_newsletter_delivery.sql"));
    const legacy = (await sql("select status from SCHEMA.newsletter_sends order by id")).rows.map(r => r.status);
    expect(legacy).toEqual(["unknown", "sent", "unknown"]);
    expect((await sql("select count(*)::int as n from SCHEMA.newsletter_issues where frozen_at is not null")).rows[0].n).toBe(2);
    await sql(`grant usage on schema SCHEMA to service_role, anon, authenticated;
      grant select on all tables in schema SCHEMA to service_role;
      grant insert,update,delete on SCHEMA.newsletter_issues to service_role;
      revoke insert,update,delete on SCHEMA.newsletter_issues from service_role;`);
  }, 15000);
  afterAll(async () => { if (pool) { await sql("drop schema SCHEMA cascade"); await pool.end(); } });
  beforeEach(async () => {
    vi.clearAllMocks();
    provider.mockResolvedValue({ok:true,id:"mock-accepted",rateLimited:false,quotaExceeded:false});
    await sql("truncate SCHEMA.newsletter_delivery_audit, SCHEMA.newsletter_sends, SCHEMA.newsletter_issues, SCHEMA.members, SCHEMA.interests, SCHEMA.email_unsubscribes, SCHEMA.digest_notes restart identity cascade");
    await seed();
  });

  it("final completion commits archive status and counters without a later worker progress call", async () => {
    const c = (await claim())!;
    await begin(c);
    expect(await complete(c, "sent", "accepted-before-crash")).toBe(true);
    // Simulate termination here: do not call issueProgress or finish sendBatch.
    const row = (await sql("select status,recipients_count,sent_count from SCHEMA.newsletter_issues where id=$1", [issue])).rows[0];
    expect(row).toMatchObject({status:"sent",recipients_count:1,sent_count:1});
  });

  it("overlapping actual sendBatch workers make exactly one provider call", async () => {
    const entered = deferred(), release = deferred();
    provider.mockImplementation(async () => { entered.release(); await release.promise; return {ok:true,id:"accepted",rateLimited:false,quotaExceeded:false}; });
    const first = sendBatch(admin,issue,{siteUrl:context.siteUrl,issueKey:"2026-W40",limit:1});
    await entered.promise;
    const second = await sendBatch(admin,issue,{siteUrl:context.siteUrl,issueKey:"2026-W40",limit:1});
    expect(second.processed).toBe(0); expect(second.progress.done).toBe(false); expect(second.progress.active).toBe(1);
    release.release(); await first;
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await issueProgress(admin, issue)).done).toBe(true);
  });

  it("send holding the issue lock defeats an overlapping admin or MCP draft upsert", async () => {
    const tx = await pool.connect(); await tx.query("begin");
    try {
      const c = await rpc("newsletter_claim",{p_issue:issue,p_context:context},tx); expect(c).not.toBeNull();
      const edit = rpc("newsletter_save_draft",{p_key:"2026-W40",p_subject:"Changed",p_markdown:"changed"}).then(() => "saved", e => (e as Error).message);
      await tx.query("commit");
      expect(await edit).toMatch(/frozen/);
      expect((await sql("select subject from SCHEMA.newsletter_issues")).rows[0].subject).toBe("Original");
    } finally { await tx.query("rollback"); tx.release(); }
  });

  it("edit winning the lock freezes the new revision and ignores stale caller content", async () => {
    const tx = await pool.connect(); await tx.query("begin");
    try {
      await rpc("newsletter_save_draft",{p_key:"2026-W40",p_subject:"Edited",p_markdown:"edited body"},tx);
      const delivery = sendBatch(admin,issue,{subject:"stale",markdown:"stale",siteUrl:context.siteUrl,limit:1});
      await tx.query("commit"); await delivery;
      expect(provider.mock.calls[0][0].subject).toBe("Edited"); expect(provider.mock.calls[0][0].text).toContain("edited body");
    } finally { await tx.query("rollback"); tx.release(); }
  });

  it("retry only resets failed; active, unknown, sent and skipped remain untouched", async () => {
    await sql("insert into SCHEMA.newsletter_sends(issue_id,email,status) values ($1,'failed@example.invalid','failed'),($1,'unknown@example.invalid','unknown'),($1,'sent@example.invalid','sent'),($1,'skipped@example.invalid','skipped')",[issue]);
    const c = (await claim())!;
    await Promise.all([retryFailed(admin, issue), issueProgress(admin, issue)]);
    expect((await sql("select status from SCHEMA.newsletter_sends where id=$1",[c.id])).rows[0].status).toBe("claimed");
    expect((await sql("select status from SCHEMA.newsletter_sends order by id")).rows.map(r=>r.status)).toEqual(["claimed","pending","unknown","sent","skipped"]);
  });

  it("retry during a live send only delivers the separate terminal-failure recipient", async () => {
    await sql("insert into SCHEMA.newsletter_sends(issue_id,email,status) values($1,'retry@example.invalid','failed')",[issue]);
    const entered = deferred(), release = deferred();
    provider.mockImplementation(async input => {
      if(input.to === "one@example.invalid") {entered.release(); await release.promise;}
      return {ok:true,id:`accepted-${input.to}`,rateLimited:false,quotaExceeded:false};
    });
    const first = sendBatch(admin,issue,{siteUrl:context.siteUrl,limit:1}); await entered.promise;
    try {
      expect(await retryFailed(admin,issue)).toBe(1);
      const second = await sendBatch(admin,issue,{siteUrl:context.siteUrl,limit:1});
      expect(second.progress.done).toBe(false); expect(second.progress.active).toBe(1);
    } finally {release.release(); await first;}
    expect(provider.mock.calls.map(c=>c[0].to).sort()).toEqual(["one@example.invalid","retry@example.invalid"]);
    expect((await issueProgress(admin,issue)).sent).toBe(2);
  });

  it("pre-I/O lease crash releases with a new fence; stale begin never authorizes", async () => {
    const c = (await claim())!;
    await sql("update SCHEMA.newsletter_sends set lease_until=clock_timestamp()-interval '1 second' where id=$1",[c.id]);
    const next = (await claim())!; expect(next.fence).toBeGreaterThan(c.fence);
    expect(await begin(c)).toBeNull(); expect(await begin(next)).not.toBeNull();
  });

  it("provider-accepted then process crash is quarantined; stale completion and retry cannot resend", async () => {
    const c = (await claim())!; await begin(c);
    // Provider accepted but the worker never completed its transaction.
    await provider(payload(),{idempotencyKey:"mock-call"});
    await sql("update SCHEMA.newsletter_sends set lease_until=clock_timestamp()-interval '1 second' where id=$1",[c.id]);
    expect(await claim()).toBeNull(); expect(await complete(c,"sent","accepted")).toBe(false);
    expect(await retryFailed(admin,issue)).toBe(0);
    await sendBatch(admin,issue,{siteUrl:context.siteUrl,limit:1});
    expect(provider).toHaveBeenCalledTimes(1); expect((await issueProgress(admin,issue)).unknown).toBe(1);
  });

  it("lost provider acknowledgement is unknown even before the lease expires", async () => {
    provider.mockRejectedValue(new Error("accepted, response lost"));
    await sendBatch(admin,issue,{siteUrl:context.siteUrl,limit:1});
    expect((await issueProgress(admin,issue)).unknown).toBe(1);
    await retryFailed(admin,issue); await sendBatch(admin,issue,{siteUrl:context.siteUrl,limit:1});
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("late unsubscribe skips before first provider call", async () => {
    const c = (await claim())!;
    await sql("insert into SCHEMA.email_unsubscribes(email) values('ONE@example.invalid')");
    expect(await begin(c)).toBeNull(); expect((await issueProgress(admin,issue)).skipped).toBe(1);
    expect(provider).not.toHaveBeenCalled();
  });

  it("unsubscribe read error fails closed", async () => {
    await sql("alter table SCHEMA.email_unsubscribes rename to unavailable_unsubscribes");
    try { await expect(sendBatch(admin,issue,{siteUrl:context.siteUrl,limit:1})).rejects.toThrow(); expect(provider).not.toHaveBeenCalled(); }
    finally { await sql("alter table SCHEMA.unavailable_unsubscribes rename to email_unsubscribes"); }
  });

  it("failed retry uses the persisted personalized payload after secret/from/content changes", async () => {
    provider.mockResolvedValueOnce({ok:false,rateLimited:false,quotaExceeded:false,error:"explicit 422 rejection"});
    await sendBatch(admin,issue,{siteUrl:context.siteUrl,limit:1});
    const firstPayload = structuredClone(provider.mock.calls[0][0]);
    const previous = process.env.NEWSLETTER_UNSUBSCRIBE_SECRET;
    process.env.NEWSLETTER_UNSUBSCRIBE_SECRET = "test-only-rotated";
    try {
      await retryFailed(admin,issue);
      await sendBatch(admin,issue,{subject:"changed",markdown:"changed",siteUrl:"http://localhost:9999",limit:1});
      expect(provider.mock.calls[1][0]).toEqual(firstPayload);
      expect(provider.mock.calls[1][1]?.idempotencyKey).not.toBe(provider.mock.calls[0][1]?.idempotencyKey);
    } finally { if (previous === undefined) delete process.env.NEWSLETTER_UNSUBSCRIBE_SECRET; else process.env.NEWSLETTER_UNSUBSCRIBE_SECRET = previous; }
  });

  it("cron ensure-week versus admin uses one issue and one shared ledger", async () => {
    const ids = await Promise.all([rpc("newsletter_ensure_week",{p_key:"2026-W40",p_subject:"cron",p_html:"cron",p_text:"cron"}),
      rpc("newsletter_save_draft",{p_key:"2026-W40",p_subject:"admin",p_markdown:"authored"})]);
    expect(ids[0]).toBe(issue);
    await Promise.all([prepareIssue(admin,issue),sendBatch(admin,issue,{siteUrl:context.siteUrl,limit:1})]);
    expect((await sql("select count(*)::int n from SCHEMA.newsletter_issues")).rows[0].n).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1); expect(provider.mock.calls[0][0].subject).toBe("admin");
    await prepareIssue(admin,issue); expect((await issueProgress(admin,issue)).total).toBe(1);
  });

  it("actual cron route overlaps admin sendBatch without a second provider call", async () => {
    vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date("2026-09-29T16:00:00Z"));
    vi.stubEnv("CRON_SECRET","test-only-cron"); vi.stubEnv("NEWSLETTER_AUTOSEND_ENABLED","true");
    vi.mocked(compileIssue).mockResolvedValue({issueKey:"2026-W40", subject:"cron contender",note:null,events:[],
      stats:{monthLabel:"test",mrrCents:0,payingMembers:0,tierCounts:[],newMembers:0,totalVisits:0,distinctVisitors:0,dayCodesIssued:0,freeDaySignups:0}});
    const entered = deferred(), release = deferred();
    provider.mockImplementation(async () => {entered.release(); await release.promise; return {ok:true,id:"cron-accepted",rateLimited:false,quotaExceeded:false};});
    const worker = sendBatch(admin,issue,{siteUrl:context.siteUrl,limit:1}); await entered.promise;
    try {
      const response = await cronPOST(new Request("http://localhost/api/cron/newsletter", {method:"POST",headers:{authorization:"Bearer test-only-cron","Content-Type":"application/json"},body:JSON.stringify({force:true})}));
      expect(response.status).toBe(200); expect((await response.json()).skipped).toBe(true);
    } finally {release.release(); await worker; vi.useRealTimers(); vi.unstubAllEnvs();}
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("lost database completion after provider acceptance never leads to automatic replay", async () => {
    const faultyAdmin = {rpc: async (name: string, args: Record<string, unknown>) =>
      name === "newsletter_complete" ? {data:null,error:{message:"completion connection lost"}} : admin.rpc(name,args)} as unknown as ReturnType<typeof createServiceClient>;
    await expect(sendBatch(faultyAdmin,issue,{siteUrl:context.siteUrl,limit:1})).rejects.toThrow(/completion/);
    await sql("update SCHEMA.newsletter_sends set lease_until=clock_timestamp()-interval '1 second'");
    await retryFailed(admin,issue); await sendBatch(admin,issue,{siteUrl:context.siteUrl,limit:1});
    expect(provider).toHaveBeenCalledTimes(1); expect((await issueProgress(admin,issue)).unknown).toBe(1);
  });

  it("lost begin acknowledgement fails closed before external I/O", async () => {
    const faultyAdmin = {rpc: async (name: string, args: Record<string, unknown>) => {
      const result = await admin.rpc(name,args);
      return name === "newsletter_begin" ? {data:null,error:{message:"begin acknowledgement lost"}} : result;
    }} as unknown as ReturnType<typeof createServiceClient>;
    await expect(sendBatch(faultyAdmin,issue,{siteUrl:context.siteUrl,limit:1})).rejects.toThrow(/acknowledgement/);
    expect(provider).not.toHaveBeenCalled();
    await sql("update SCHEMA.newsletter_sends set lease_until=clock_timestamp()-interval '1 second'");
    expect((await issueProgress(admin,issue)).unknown).toBe(1);
  });

  it("database trigger rejects owner-level frozen content changes and deletion too", async () => {
    await claim();
    await expect(sql("update SCHEMA.newsletter_issues set subject='tampered' where id=$1",[issue])).rejects.toThrow(/frozen/);
    await expect(sql("update SCHEMA.newsletter_issues set delivery_snapshot='{}'::jsonb where id=$1",[issue])).rejects.toThrow(/frozen/);
    await expect(sql("delete from SCHEMA.newsletter_issues where id=$1",[issue])).rejects.toThrow(/frozen/);
  });

  it("scheduled calls deliver recipient 21 from the same older issue across an even-week boundary", async () => {
    await sql("update SCHEMA.newsletter_issues set issue_key='2026-W39' where id=$1",[issue]);
    await sql("insert into SCHEMA.interests(email) select 'bulk-' || n || '@example.invalid' from generate_series(1,20) n");
    await prepareIssue(admin,issue);
    vi.stubEnv("CRON_SECRET","test-only-cron"); vi.stubEnv("NEWSLETTER_AUTOSEND_ENABLED","true");
    vi.useFakeTimers({toFake:["Date"]});
    const tick = () => cronPOST(new Request("http://localhost/api/cron/newsletter",{method:"POST",headers:{authorization:"Bearer test-only-cron","Content-Type":"application/json"},body:"{}"}));
    try {
      vi.setSystemTime(new Date("2026-09-22T16:00:00Z"));
      const first = await (await tick()).json(); expect(first.issue_id).toBe(issue); expect(first.processed).toBe(20); expect(first.progress.pending).toBe(1);
      vi.setSystemTime(new Date("2026-10-07T16:00:00Z"));
      const second = await (await tick()).json(); expect(second.issue_id).toBe(issue); expect(second.issue_key).toBe("2026-W39"); expect(second.processed).toBe(1); expect(second.progress.done).toBe(true);
      expect(provider).toHaveBeenCalledTimes(21); expect(vi.mocked(compileIssue)).not.toHaveBeenCalled();
      expect((await sql("select count(*)::int n from SCHEMA.newsletter_issues")).rows[0].n).toBe(1);
    } finally {vi.useRealTimers();vi.unstubAllEnvs();}
  },20000);

  it("scheduled quota/cooldown continuation survives week rollover without creating a new issue", async () => {
    await sql("update SCHEMA.newsletter_issues set issue_key='2026-W39' where id=$1",[issue]);
    vi.stubEnv("CRON_SECRET","test-only-cron"); vi.stubEnv("NEWSLETTER_AUTOSEND_ENABLED","true");
    vi.useFakeTimers({toFake:["Date"]});
    provider.mockResolvedValueOnce({ok:false,quotaExceeded:true,rateLimited:false,error:"known quota rejection"});
    const tick = () => cronPOST(new Request("http://localhost/api/cron/newsletter",{method:"POST",headers:{authorization:"Bearer test-only-cron","Content-Type":"application/json"},body:"{}"}));
    try {
      vi.setSystemTime(new Date("2026-09-27T23:00:00Z"));
      const limited = await (await tick()).json();expect(limited.quotaReached).toBe(true);expect(limited.issue_id).toBe(issue);
      expect((await (await tick()).json()).skipped).toBe(true);expect(provider).toHaveBeenCalledTimes(1);
      await sql("update SCHEMA.newsletter_sends set retry_after=clock_timestamp()-interval '1 second'");
      vi.setSystemTime(new Date("2026-10-07T16:00:00Z"));
      const resumed = await (await tick()).json();expect(resumed.issue_id).toBe(issue);expect(resumed.progress.done).toBe(true);
      expect(provider).toHaveBeenCalledTimes(2);expect(vi.mocked(compileIssue)).not.toHaveBeenCalled();
    } finally {vi.useRealTimers();vi.unstubAllEnvs();}
  });

  it("cron startup crash before preparation is discoverable on a wrong-day continuation tick", async () => {
    const id = await rpc<number>("newsletter_ensure_week",{p_key:"2026-W39",p_subject:"Prepared later",p_html:"body",p_text:"body"});
    const target = await rpc<{id:number}>("newsletter_cron_target",{p_start_key:null});
    // The seeded issue has pending work and is older; complete it first.
    await sendBatch(admin,issue,{siteUrl:context.siteUrl,limit:1});expect(target.id).toBe(issue);
    expect((await rpc<{id:number}>("newsletter_cron_target",{p_start_key:null})).id).toBe(id);
  });

  it("recurring cron does not pick an unrelated manually prepared draft", async () => {
    await sendBatch(admin,issue,{siteUrl:context.siteUrl,limit:1});
    const draft = await rpc<{id:number}>("newsletter_save_draft",{p_key:"2026-W99-2",p_subject:"Manual only",p_markdown:"body"});
    await prepareIssue(admin,draft.id);
    expect(await rpc("newsletter_cron_target",{p_start_key:null})).toBeNull();
  });

  it("a cooling-down old issue cannot block a new eligible Tuesday start, then resumes when ready", async () => {
    await sql("update SCHEMA.newsletter_sends set retry_after=clock_timestamp()+interval '2 days' where issue_id=$1",[issue]);
    expect(await rpc("newsletter_cron_target",{p_start_key:"2026-W41"})).toBeNull();
    const next = await rpc<number>("newsletter_ensure_week",{p_key:"2026-W41",p_subject:"Next",p_html:"body",p_text:"body"});
    await prepareIssue(admin,next);
    expect((await rpc<{id:number}>("newsletter_cron_target",{p_start_key:"2026-W41"})).id).toBe(next);
    await sendBatch(admin,next,{siteUrl:context.siteUrl,limit:1});
    expect(await rpc("newsletter_cron_target",{p_start_key:null})).toBeNull();
    await sql("update SCHEMA.newsletter_sends set retry_after=clock_timestamp()-interval '1 second' where issue_id=$1",[issue]);
    expect((await rpc<{id:number}>("newsletter_cron_target",{p_start_key:null})).id).toBe(issue);
  });

  it("eligible authored Tuesday draft starts once before old runnable work, then both get turns", async () => {
    const next = await rpc<{id:number}>("newsletter_save_draft",{p_key:"2026-W41",p_subject:"Authored",p_markdown:"authored"});
    await prepareIssue(admin,next.id);
    const first = await rpc<{id:number}>("newsletter_cron_target",{p_start_key:"2026-W41"});expect(first.id).toBe(next.id);
    expect((await rpc<{id:number}>("newsletter_cron_target",{p_start_key:"2026-W41"})).id).toBe(issue);
    expect((await rpc<{id:number}>("newsletter_cron_target",{p_start_key:"2026-W41"})).id).toBe(next.id);
  });

  it("durable scheduling rotates runnable issues even when the oldest repeatedly fails without progress", async () => {
    const next = await rpc<number>("newsletter_ensure_week",{p_key:"2026-W41",p_subject:"Next",p_html:"body",p_text:"body"});
    await prepareIssue(admin,next);
    const selected:number[]=[];
    for(let j=0;j<4;j++) selected.push((await rpc<{id:number}>("newsletter_cron_target",{p_start_key:null})).id);
    expect(selected).toEqual([issue,next,issue,next]);
  });

  it("fresh active leases do not monopolize scheduling; expired claims and sending are selected for cleanup", async () => {
    const c = (await claim())!;
    const next = await rpc<number>("newsletter_ensure_week",{p_key:"2026-W41",p_subject:"Next",p_html:"body",p_text:"body"});
    await prepareIssue(admin,next);
    expect((await rpc<{id:number}>("newsletter_cron_target",{p_start_key:null})).id).toBe(next);
    await sendBatch(admin,next,{siteUrl:context.siteUrl,limit:1});
    expect(await rpc("newsletter_cron_target",{p_start_key:null})).toBeNull();
    await sql("update SCHEMA.newsletter_sends set lease_until=clock_timestamp()-interval '1 second' where id=$1",[c.id]);
    expect((await rpc<{id:number}>("newsletter_cron_target",{p_start_key:null})).id).toBe(issue);
    const recovered = (await claim())!; await begin(recovered);
    expect(await rpc("newsletter_cron_target",{p_start_key:null})).toBeNull();
    await sql("update SCHEMA.newsletter_sends set lease_until=clock_timestamp()-interval '1 second' where id=$1",[c.id]);
    expect((await rpc<{id:number}>("newsletter_cron_target",{p_start_key:null})).id).toBe(issue);
    expect((await issueProgress(admin,issue)).unknown).toBe(1);
    expect(await rpc("newsletter_cron_target",{p_start_key:null})).toBeNull();
  });

  it("concurrent preparation cannot add recipients after delivery freeze", async () => {
    await claim(); await sql("insert into SCHEMA.interests(email) values('later@example.invalid')");
    await Promise.all([prepareIssue(admin,issue),issueProgress(admin,issue)]);
    expect((await issueProgress(admin,issue)).total).toBe(1);
  });

  it("unknown manual resolution requires audit evidence and current fence", async () => {
    const c = (await claim())!; await begin(c); await complete(c,"unknown");
    await expect(rpc("newsletter_resolve",{p_issue:issue,p_send:c.id,p_fence:c.fence,p_outcome:"failed",p_actor:"operator",p_evidence:"no"})).rejects.toThrow(/evidence/);
    await rpc("newsletter_resolve",{p_issue:issue,p_send:c.id,p_fence:c.fence,p_outcome:"sent",p_actor:"operator",p_evidence:"Provider export confirms acceptance: mocked provider record 123",p_provider_id:"record-123"});
    expect((await sql("select count(*)::int n from SCHEMA.newsletter_delivery_audit")).rows[0].n).toBe(1);
    expect(await complete(c,"failed")).toBe(false); expect(await retryFailed(admin,issue)).toBe(0);
  });

  it("service-role direct issue and ledger writes and anonymous RPC execution are denied", async () => {
    const tx = await pool.connect();
    try {
      await tx.query("set role service_role");
      await expect(tx.query(`update ${schema}.newsletter_sends set status='sent'`)).rejects.toThrow(/permission/);
      await expect(tx.query(`update ${schema}.newsletter_issues set status='sent'`)).rejects.toThrow(/permission/);
      await tx.query("reset role"); await tx.query("set role anon");
      await expect(tx.query(`select ${schema}.newsletter_retry_failed($1)`,[issue])).rejects.toThrow(/permission/);
    } finally { await tx.query("reset role"); tx.release(); }
  });
});
