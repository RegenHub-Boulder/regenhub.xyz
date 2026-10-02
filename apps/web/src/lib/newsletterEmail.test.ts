import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({send: vi.fn()}));
vi.mock("resend", () => ({Resend: class { emails = {send}; }}));
import { sendEmailDetailed } from "./email";
const input = {to:"recipient@example.invalid",subject:"test",html:"<p>test</p>",text:"test",from:"from@example.invalid",replyTo:"reply@example.invalid"};

describe("newsletter provider acceptance classification", () => {
  beforeEach(() => { vi.stubEnv("RESEND_API_KEY","mock-only"); send.mockReset(); });
  it("passes the official SDK second-argument idempotency option and frozen payload", async () => {
    send.mockResolvedValue({data:{id:"mock-id"},error:null});
    expect((await sendEmailDetailed(input,{idempotencyKey:"newsletter/1/1/1"})).ok).toBe(true);
    expect(send).toHaveBeenCalledWith(input,{idempotencyKey:"newsletter/1/1/1"});
  });
  it.each([null,500,502,408,409])("quarantines uncertain provider errors (%s)", async statusCode => {
    send.mockResolvedValue({data:null,error:{statusCode,message:"unknown"}});
    expect((await sendEmailDetailed(input)).uncertain).toBe(true);
  });
  it("never interprets a thrown transport rate-limit-looking message as safe rejection", async () => {
    send.mockRejectedValue(new Error("429 connection dropped after write"));
    const r = await sendEmailDetailed(input); expect(r.uncertain).toBe(true); expect(r.rateLimited).toBe(false);
  });
  it("treats explicit 422 rejection as terminal retryable failure", async () => {
    send.mockResolvedValue({data:null,error:{statusCode:422,message:"invalid recipient"}});
    const r = await sendEmailDetailed(input); expect(r.ok).toBe(false); expect(r.uncertain).toBe(false);
  });
  it("retains quota and rate-limit operator behavior only for explicit rejection", async () => {
    send.mockResolvedValueOnce({data:null,error:{statusCode:429,message:"daily quota exceeded"}})
      .mockResolvedValueOnce({data:null,error:{statusCode:429,message:"too many requests"}});
    expect((await sendEmailDetailed(input)).quotaExceeded).toBe(true);
    expect((await sendEmailDetailed(input)).rateLimited).toBe(true);
  });
});
