import { beforeEach, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { makeSupabaseMock } from "../../../test/mockSupabase";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));

const pages = [
  { name: "dashboard", render: async () => (await import("./page")).default() },
  { name: "pipeline", render: async () => (await import("./pipeline/page")).default({ searchParams: Promise.resolve({}) }) },
  { name: "newsletter", render: async () => (await import("./newsletter/page")).default() },
  { name: "member detail", render: async () => (await import("./members/[id]/page")).default({ params: Promise.resolve({ id: "1" }) }) },
];

beforeEach(() => vi.clearAllMocks());
for (const { name, render } of pages) {
  it.each(["unauthenticated", "non-admin", "disabled-admin"])(`${name} denies %s before service reads`, async (state) => {
    const session = makeSupabaseMock({
      auth: { user: state === "unauthenticated" ? null : { id: "caller", email: "caller@example.test" } },
      selects: { members: { data: { is_admin: state === "disabled-admin", disabled: state === "disabled-admin" } } },
    });
    const service = makeSupabaseMock();
    vi.mocked(createClient).mockResolvedValue(session as never);
    vi.mocked(createServiceClient).mockReturnValue(service as never);
    await expect(render()).rejects.toThrow("NEXT_REDIRECT");
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(service.from).not.toHaveBeenCalled();
  });
}
