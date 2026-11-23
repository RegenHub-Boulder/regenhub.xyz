import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePortalMember: vi.fn(),
  createServiceClient: vi.fn(),
  processOnchainInvoice: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/onchain/portalMember", () => ({ requirePortalMember: mocks.requirePortalMember }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock("@/lib/onchain/config", () => ({ isOnchainBillingConfigured: () => true }));
vi.mock("@/lib/onchain/verifyPayment", () => ({ processOnchainInvoice: mocks.processOnchainInvoice }));
vi.mock("@/lib/auditLog", () => ({ AuditAction: { ONCHAIN_PAYMENT_AFTER_VOID: "x" }, logAction: vi.fn() }));

import { POST } from "./route";

const hash = `0x${"ab".repeat(32)}`;
const other = `0x${"cd".repeat(32)}`;

function useInvoice(row: Record<string, unknown> | null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ["select", "eq", "in"]) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  chain.single = vi.fn(async () => ({ data: row, error: null }));
  chain.update = vi.fn((...a) => { mocks.update(...a); return chain; });
  mocks.createServiceClient.mockReturnValue({ from: () => chain });
}

const post = (tx = hash) => POST(new Request("http://x/api/portal/onchain/submit", {
  method: "POST", body: JSON.stringify({ invoice_id: 5, tx_hash: tx }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePortalMember.mockResolvedValue({ member: { id: 7 } });
});

describe("POST /api/portal/onchain/submit, payment already finished", () => {
  it("answers paid when the invoice is already paid with the same transaction", async () => {
    useInvoice({ id: 5, status: "paid", submitted_tx_hash: hash });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "paid", txHash: hash });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.processOnchainInvoice).not.toHaveBeenCalled();
  });

  it("accepts the hash in any letter case, as the invoice stores it lowercase", async () => {
    useInvoice({ id: 5, status: "paid", submitted_tx_hash: hash });
    const res = await post(`0x${"AB".repeat(32)}`);
    expect(res.status).toBe(200);
  });

  it("still refuses a paid invoice for a different transaction", async () => {
    useInvoice({ id: 5, status: "paid", submitted_tx_hash: other });
    expect((await post()).status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("still refuses a paid invoice with no recorded transaction", async () => {
    useInvoice({ id: 5, status: "paid", submitted_tx_hash: null });
    expect((await post()).status).toBe(404);
  });

  it("does not find another member's invoice", async () => {
    useInvoice(null);
    expect((await post()).status).toBe(404);
  });
});
