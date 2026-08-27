import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/applicationNotify", () => ({
  notifyNewApplication: vi.fn(),
  interestLabel: vi.fn(() => "Hot Desk"),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => undefined),
  applicationReceivedEmail: vi.fn(() => ({ subject: "Received", html: "ok", text: "ok" })),
}));

import { POST } from "./route";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/portal/application", () => {
  it("writes validated applicant fields through the server client", async () => {
    const publicFrom = vi.fn();
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-1", email: "member@example.org" } } })) },
      from: publicFrom,
    } as never);

    let updated: Record<string, unknown> | null = null;
    const lookup: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["select", "eq"]) lookup[method] = vi.fn(() => lookup);
    lookup.maybeSingle = vi.fn(async () => ({ data: { id: 12, email: "member@example.org" }, error: null }));

    const mutation: Record<string, ReturnType<typeof vi.fn>> = {};
    mutation.update = vi.fn((values: Record<string, unknown>) => { updated = values; return mutation; });
    for (const method of ["eq", "select"]) mutation[method] = vi.fn(() => mutation);
    mutation.single = vi.fn(async () => ({ data: { id: 12 }, error: null }));

    let calls = 0;
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn(() => calls++ === 0 ? lookup : mutation),
    } as never);

    const response = await POST(new Request("http://localhost/api/portal/application", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Member", membership_interest: "hot_desk" }),
    }));

    expect(response.status).toBe(200);
    expect(updated).toMatchObject({
      supabase_user_id: "auth-1",
      email: "member@example.org",
      name: "Member",
      membership_interest: "hot_desk",
      status: "pending",
    });
    expect(publicFrom).not.toHaveBeenCalled();
  });
});
