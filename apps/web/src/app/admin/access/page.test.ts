import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { makeSupabaseMock } from "../../../../test/mockSupabase";
import AccessPage from "./page";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/components/admin/AdminTabs", () => ({ AdminTabs: ({ children }: { children: { sync: unknown } }) => children.sync }));
vi.mock("@/components/admin/QuarantinedSlots", () => ({ QuarantinedSlots: () => null }));
vi.mock("@/components/admin/LockSyncSection", () => ({ LockSyncSection: () => null }));
vi.mock("@/components/admin/LiveCodesSection", () => ({ LiveCodesSection: () => null }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
for (const seconds of [30, 120, 121]) {
  it(`shows safe holder and age at ${seconds}s, warns only past two minutes`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const service = makeSupabaseMock({ selects: {
      lock_slot_writer: { data: { acquired_at: new Date(Date.now() - seconds * 1000).toISOString(), holder_label: "Bot PIN writer", token: "private-token" } },
      lock_slot_quarantine: { data: [] },
    } });
    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ auth: { user: { id: "admin", email: "admin@example.test" } }, selects: { members: { data: { is_admin: true, disabled: false } } } }) as never);
    vi.mocked(createServiceClient).mockReturnValue(service as never);
    const markup = renderToStaticMarkup(await AccessPage());
    expect(markup).toContain(`Bot PIN writer for ${seconds} seconds`);
    expect(markup).toContain("Stuck reservation recovery");
    expect(markup).not.toContain("private-token");
    expect(markup.includes('role="alert"')).toBe(seconds > 120);
    expect(markup.includes("text-red-600")).toBe(seconds > 120);
    expect(service.from.mock.results[1].value.select).toHaveBeenCalledWith("acquired_at, holder_label");
  });
}
it("shows no held reservation when free", async () => {
  vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ auth: { user: { id: "admin", email: "admin@example.test" } }, selects: { members: { data: { is_admin: true, disabled: false } } } }) as never);
  vi.mocked(createServiceClient).mockReturnValue(makeSupabaseMock() as never);
  expect(renderToStaticMarkup(await AccessPage())).not.toContain("Door-code writer held");
});

for (const state of ["unauthenticated", "non-admin", "disabled-admin"]) {
  it(`denies ${state} before any service-role read`, async () => {
    const session = makeSupabaseMock({
      auth: { user: state === "unauthenticated" ? null : { id: "caller", email: "caller@example.test" } },
      selects: { members: { data: { is_admin: state === "disabled-admin", disabled: state === "disabled-admin" } } },
    });
    const service = makeSupabaseMock();
    vi.mocked(createClient).mockResolvedValue(session as never);
    vi.mocked(createServiceClient).mockReturnValue(service as never);
    await expect(AccessPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(service.from).not.toHaveBeenCalled();
  });
}
