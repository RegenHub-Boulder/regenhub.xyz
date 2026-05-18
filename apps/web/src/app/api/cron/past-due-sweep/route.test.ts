import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock } from "../../../../../test/mockSupabase";

vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));

import { POST } from "./route";
import { createServiceClient } from "@/lib/supabase/admin";

function makeRequest(auth?: string): Request {
  return new Request("http://localhost/api/cron/past-due-sweep", {
    method: "POST",
    headers: auth ? { Authorization: auth } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/cron/past-due-sweep", () => {
  it("returns 503 when CRON_SECRET is not configured", async () => {
    const prev = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    const res = await POST(makeRequest("Bearer anything"));
    expect(res.status).toBe(503);
    if (prev) process.env.CRON_SECRET = prev;
  });

  it("returns 401 with bad bearer token", async () => {
    process.env.CRON_SECRET = "secret-1";
    const res = await POST(makeRequest("Bearer wrong"));
    expect(res.status).toBe(401);
  });

  it("returns 401 with no auth header", async () => {
    process.env.CRON_SECRET = "secret-1";
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns swept=0 when no stale subscriptions found", async () => {
    process.env.CRON_SECRET = "secret-1";
    const sb = makeSupabaseMock({ selects: { subscriptions: { data: [] } } });
    vi.mocked(createServiceClient).mockReturnValue(sb as never);

    const res = await POST(makeRequest("Bearer secret-1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.swept).toBe(0);
    expect(json.flipped).toBe(0);
  });
});
