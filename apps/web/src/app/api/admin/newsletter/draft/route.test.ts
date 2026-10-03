import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ existing: { status: "draft", delivery_snapshot: null as unknown }, error: null as unknown }));
vi.mock("@/lib/admin", () => ({ requireAdmin: async () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: () => ({
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.existing }) }) }),
    upsert: () => ({ select: () => ({ single: async () => ({ data: {}, error: mocks.error }) }) }),
  }),
}) }));
import { POST } from "./route";
afterEach(() => { mocks.existing = { status: "draft", delivery_snapshot: null }; mocks.error = null; });
function save() { return POST(new Request("https://example.com", { method: "POST", body: JSON.stringify({ subject: "new", markdown: "new" }) })); }
it("rejects edits to a sending revision", async () => {
  mocks.existing.status = "sending"; expect((await save()).status).toBe(409);
});
it("rejects a frozen revision even if stale status says draft", async () => {
  mocks.existing.delivery_snapshot = {}; expect((await save()).status).toBe(409);
});
it("maps database freeze fencing an edit-vs-send race to conflict", async () => {
  mocks.error = { code: "55000" }; expect((await save()).status).toBe(409);
});
