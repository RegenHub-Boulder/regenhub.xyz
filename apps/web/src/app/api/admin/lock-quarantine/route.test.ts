import { beforeEach, expect, it, vi } from "vitest";
import { makeSupabaseMock } from "../../../../../test/mockSupabase";

const ha = vi.hoisted(() => ({ outcome: "success" }));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => ({ id: "admin" })) }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@regenhub/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@regenhub/shared")>();
  return { ...actual, clearUserCode: vi.fn((slot: number) => actual.clearSlotSafely(slot, async () => {
    if (ha.outcome === "throw") throw new Error("mock timeout");
    return [{ entity: "front", ok: true }, { entity: "back", ok: ha.outcome === "success" }];
  }, ["front", "back"])) };
});
import { POST } from "./route";
import { createServiceClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/admin";
import { clearUserCode } from "@regenhub/shared";

beforeEach(() => { vi.clearAllMocks(); ha.outcome = "success"; vi.mocked(requireAdmin).mockResolvedValue({ id: "admin" } as never); });
function request() { return new Request("http://localhost/api/admin/lock-quarantine", { method: "POST", body: JSON.stringify({ slot: 101 }) }); }

it.each(["partial", "throw", "success"])("retry %s releases only after all-door success", async outcome => {
  ha.outcome = outcome;
  const sb = makeSupabaseMock({ selects: { members: { data: null }, day_codes: { data: [{ id: 1 }] } } });
  let quarantined = true;
  sb.rpc.mockImplementation(async (name: string) => {
    if (name === "release_lock_quarantine") quarantined = false;
    if (name === "quarantine_lock_slot") quarantined = true;
    return { data: name === "list_lock_quarantines" ? (quarantined ? [{ slot: 101 }] : []) : true, error: null };
  });
  vi.mocked(createServiceClient).mockReturnValue(sb as never);
  const response = await POST(request());
  expect(response.status).toBe(outcome === "success" ? 200 : 502);
  expect(quarantined).toBe(outcome !== "success");
  const mutations = sb.from.mock.results.flatMap(result => {
    const builder = result.value as Record<string, unknown>;
    return vi.mocked(builder.update as ReturnType<typeof vi.fn>).mock.calls;
  });
  expect(mutations).toHaveLength(outcome === "success" ? 1 : 0);
});

it("denies non-admin retry before lock I/O", async () => {
  vi.mocked(requireAdmin).mockResolvedValue(null as never);
  expect((await POST(request())).status).toBe(403);
  expect(clearUserCode).not.toHaveBeenCalled();
});

it("rejects a retry of an ordinary assigned slot", async () => {
  vi.mocked(createServiceClient).mockReturnValue(makeSupabaseMock() as never);
  expect((await POST(request())).status).toBe(409);
  expect(clearUserCode).not.toHaveBeenCalled();
});
