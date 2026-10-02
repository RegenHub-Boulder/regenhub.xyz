import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({admin:{},compile:vi.fn(),rpc:vi.fn(),prepare:vi.fn(),batch:vi.fn(),week:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createServiceClient:()=>mocks.admin}));
vi.mock("@/lib/newsletter",()=>({compileIssue:mocks.compile,renderNewsletterHtml:()=>"compiled html",renderNewsletterText:()=>"compiled text",isoWeek:mocks.week,issueKeyFor:()=>"2026-W41"}));
vi.mock("@/lib/newsletterSend",()=>({newsletterRpc:mocks.rpc,prepareIssue:mocks.prepare,sendBatch:mocks.batch,UNSUBSCRIBE_PLACEHOLDER:"{{NEWSLETTER_UNSUBSCRIBE}}"}));
import { POST } from "@/app/api/cron/newsletter/route";
const request = (force=false) => new Request("http://localhost/api/cron/newsletter",{method:"POST",headers:{authorization:"Bearer test-only", "Content-Type":"application/json"},body:JSON.stringify({force})});
describe("cron newsletter coordinates the shared ledger",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-06T16:00:00Z"));vi.stubEnv("CRON_SECRET","test-only");vi.stubEnv("NEWSLETTER_AUTOSEND_ENABLED","true");vi.stubEnv("NEXT_PUBLIC_SITE_URL","http://localhost");
    mocks.week.mockReturnValue({week:41});mocks.compile.mockResolvedValue({issueKey:"2026-W41",subject:"cron",note:null,events:[]});
    mocks.rpc.mockImplementation(async (_admin,name)=>name === "newsletter_cron_target" ? null : 7);mocks.batch.mockResolvedValue({processed:1,progress:{done:false,unknown:1}});
  });
  afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
  it("resumes an older unfinished issue on an even-week Wednesday instead of stranding recipient 21",async()=>{
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-07T16:00:00Z"));
    mocks.week.mockReturnValue({week:40});
    mocks.rpc.mockImplementation(async (_admin, name) => name === "newsletter_cron_target" ? {id:6,issueKey:"2026-W39",finished:false} : 7);
    try {
      const response = await POST(request());
      expect(mocks.batch).toHaveBeenCalledWith(mocks.admin,6,expect.objectContaining({issueKey:"2026-W39",limit:20}));
      expect((await response.json()).issue_id).toBe(6);
      expect(mocks.compile).not.toHaveBeenCalled();
    } finally {vi.useRealTimers();}
  });
  it("force preserves the kill switch",async()=>{
    vi.stubEnv("NEWSLETTER_AUTOSEND_ENABLED","false");expect((await (await POST(request(true))).json()).skipped).toBe(true);expect(mocks.compile).not.toHaveBeenCalled();
  });
  it("even weeks skip unless forced",async()=>{
    mocks.week.mockReturnValue({week:40});expect((await (await POST(request())).json()).skipped).toBe(true);expect(mocks.compile).not.toHaveBeenCalled();
    await POST(request(true));expect(mocks.batch).toHaveBeenCalledTimes(1);
  });
  it("uses canonical issue RPC, prepare, and the same admin sendBatch, without action-log send bypass",async()=>{
    const response = await POST(request());expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(mocks.admin,"newsletter_ensure_week",expect.objectContaining({p_key:"2026-W41"}));
    expect(mocks.prepare).toHaveBeenCalledWith(mocks.admin,7);expect(mocks.batch).toHaveBeenCalledWith(mocks.admin,7,expect.objectContaining({issueKey:"2026-W41",limit:20}));
  });
  it("fails closed on ledger preparation error",async()=>{
    mocks.prepare.mockRejectedValueOnce(new Error("database unavailable"));expect((await POST(request())).status).toBe(503);expect(mocks.batch).not.toHaveBeenCalled();
  });
  it("an odd-week wrong-day tick cannot start a new issue",async()=>{
    vi.setSystemTime(new Date("2026-10-07T16:00:00Z"));mocks.week.mockReturnValue({week:41});
    expect((await (await POST(request())).json()).skipped).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith(mocks.admin,"newsletter_cron_target",{p_start_key:null});
    expect(mocks.compile).not.toHaveBeenCalled();expect(mocks.batch).not.toHaveBeenCalled();
  });
  it("cooldown continuation keeps the old key and is attempted again on the next scheduled tick",async()=>{
    mocks.rpc.mockImplementation(async()=>({id:6,issueKey:"2026-W39",finished:false}));
    mocks.batch.mockResolvedValue({processed:0,progress:{done:false,pending:1}});
    await POST(request());vi.setSystemTime(new Date("2026-10-14T16:00:00Z"));mocks.week.mockReturnValue({week:42});
    mocks.batch.mockResolvedValue({processed:1,progress:{done:true,pending:0}});await POST(request());
    expect(mocks.batch.mock.calls.map(c=>c[1])).toEqual([6,6]);expect(mocks.compile).not.toHaveBeenCalled();
  });
  it("completed weekly issues are not recompiled on every recurring Tuesday tick",async()=>{
    mocks.rpc.mockResolvedValue({id:7,issueKey:"2026-W41",finished:true});
    expect((await (await POST(request())).json()).skipped).toBe(true);expect(mocks.compile).not.toHaveBeenCalled();expect(mocks.batch).not.toHaveBeenCalled();
  });
  it("an already-started Tuesday issue with no runnable rows waits without recompiling or sending",async()=>{
    mocks.rpc.mockResolvedValue({id:7,issueKey:"2026-W41",finished:false,waiting:true});
    const response = await (await POST(request())).json();
    expect(response.skipped).toBe(true);expect(response.reason).toMatch(/waiting/);
    expect(mocks.prepare).not.toHaveBeenCalled();expect(mocks.batch).not.toHaveBeenCalled();expect(mocks.compile).not.toHaveBeenCalled();
  });

});
