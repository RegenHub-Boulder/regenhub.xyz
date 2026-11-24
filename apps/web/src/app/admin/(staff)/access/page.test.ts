import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { makeSupabaseMock } from "../../../../../test/mockSupabase";
import AccessPage from "./page";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/components/admin/AdminTabs", () => ({ AdminTabs: ({ children }: { children: { sync: unknown } }) => children.sync }));
vi.mock("@/components/admin/QuarantinedSlots", () => ({ QuarantinedSlots: () => null }));
vi.mock("@/components/admin/LockSyncSection", () => ({ LockSyncSection: () => null }));
vi.mock("@/components/admin/LiveCodesSection", () => ({ LiveCodesSection: () => null }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const cases = [
  { name: "a live writer that renewed 10s ago, 10 minutes in", acquired: 600, renewed: 10, stuck: false },
  { name: "a writer silent for exactly the lease", acquired: 120, renewed: 120, stuck: false },
  { name: "a writer silent past the lease", acquired: 3 * 86400, renewed: 121, stuck: true },
  { name: "a pre-070 row (no renewed_at) past the lease", acquired: 121, renewed: null, stuck: true },
];
for (const c of cases) {
  it(`says plainly what the writer is doing: ${c.name}`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const service = makeSupabaseMock({ selects: {
      lock_slot_writer: { data: { acquired_at: ago(c.acquired), holder_label: "Bot PIN writer", token: "private-token",
        ...(c.renewed === null ? {} : { renewed_at: ago(c.renewed) }) } },
      lock_slot_quarantine: { data: [] },
      admin_actions: { data: [] },
    } });
    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ auth: { user: { id: "admin", email: "admin@example.test" } }, selects: { members: { data: { is_admin: true, disabled: false } } } }) as never);
    vi.mocked(createServiceClient).mockReturnValue(service as never);
    const markup = renderToStaticMarkup(await AccessPage());
    expect(markup).toContain(c.stuck ? "Bot PIN writer" : "A door-code change is running (Bot PIN writer, since");
    if (c.stuck) expect(markup).toContain(c.renewed === null ? "Until migration 070 runs" : "The next door-code change takes it over");
    expect(markup).not.toContain("private-token");
    expect(markup).not.toContain("operator recovery");
    expect(markup.includes('role="alert"')).toBe(c.stuck);
    expect(markup.includes("text-danger")).toBe(c.stuck);
    // The token is never selected.
    expect(service.from.mock.results[1].value.select).toHaveBeenCalledWith("acquired_at, holder_label, renewed_at");
  });
}
it("shows no held reservation when free", async () => {
  vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ auth: { user: { id: "admin", email: "admin@example.test" } }, selects: { members: { data: { is_admin: true, disabled: false } } } }) as never);
  vi.mocked(createServiceClient).mockReturnValue(makeSupabaseMock() as never);
  expect(renderToStaticMarkup(await AccessPage())).not.toContain("data-testid=\"lock-writer\"");
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
