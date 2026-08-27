import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePortalMember: vi.fn(),
  createServiceClient: vi.fn(),
  verifyTypedData: vi.fn(),
  processGaslessRelayQueue: vi.fn(),
}));

vi.mock("@/lib/onchain/portalMember", () => ({ requirePortalMember: mocks.requirePortalMember }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock("@/lib/onchain/config", () => ({
  isGaslessRelayConfigured: () => true,
  getOpPublicClient: () => ({ verifyTypedData: mocks.verifyTypedData }),
  assertOpPublicClient: vi.fn(async () => undefined),
}));
vi.mock("@/lib/onchain/gaslessRelay", () => ({
  authorizationTypedData: () => ({
    domain: { name: "USD Coin", version: "2", chainId: 10, verifyingContract: "0x0000000000000000000000000000000000000001" },
    types: { TransferWithAuthorization: [] },
    primaryType: "TransferWithAuthorization",
    message: {},
  }),
  processGaslessRelayQueue: mocks.processGaslessRelayQueue,
}));

import { POST } from "./route";

const signature = `0x${"11".repeat(65)}`;
const otherSignature = `0x${"22".repeat(65)}`;

const baseJob = {
  invoice_id: 101,
  member_id: 7,
  from_address: "0x1111111111111111111111111111111111111111",
  valid_before: Math.floor(Date.now() / 1000) + 1_800,
  signature: null as string | null,
  status: "prepared",
  submitted_tx_hash: null,
};

function tableBuilder(job: typeof baseJob | null, signed = true) {
  let updating = false;
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "is", "neq"]) chain[method] = vi.fn(() => chain);
  chain.update = vi.fn(() => { updating = true; return chain; });
  chain.maybeSingle = vi.fn(async () => ({
    data: updating ? (signed ? { invoice_id: 101 } : null) : job,
    error: null,
  }));
  chain.single = vi.fn(async () => ({ data: job, error: null }));
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePortalMember.mockResolvedValue({
    user: { id: "auth-1" },
    member: { id: 7, disabled: false },
  });
  mocks.verifyTypedData.mockResolvedValue(true);
  mocks.processGaslessRelayQueue.mockResolvedValue({
    status: "submitted",
    txHash: `0x${"aa".repeat(32)}`,
  });
});

describe("POST /api/portal/onchain/relay", () => {
  it("verifies the exact typed authorization before queueing the relayer", async () => {
    const jobs = tableBuilder(baseJob);
    mocks.createServiceClient.mockReturnValue({ from: () => jobs });

    const response = await POST(new Request("http://localhost/api/portal/onchain/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_id: 101, signature }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.verifyTypedData).toHaveBeenCalledWith(expect.objectContaining({
      address: baseJob.from_address,
      signature,
      primaryType: "TransferWithAuthorization",
    }));
    expect(jobs.update).toHaveBeenCalledWith(expect.objectContaining({
      signature,
      status: "signed",
    }));
    expect(mocks.processGaslessRelayQueue).toHaveBeenCalledWith(expect.anything(), 101);
    await expect(response.json()).resolves.toEqual({
      status: "submitted",
      txHash: `0x${"aa".repeat(32)}`,
    });
  });

  it("does not persist or relay an invalid signature", async () => {
    mocks.verifyTypedData.mockResolvedValue(false);
    const jobs = tableBuilder(baseJob);
    mocks.createServiceClient.mockReturnValue({ from: () => jobs });

    const response = await POST(new Request("http://localhost/api/portal/onchain/relay", {
      method: "POST",
      body: JSON.stringify({ invoice_id: 101, signature }),
    }));

    expect(response.status).toBe(401);
    expect(jobs.update).not.toHaveBeenCalled();
    expect(mocks.processGaslessRelayQueue).not.toHaveBeenCalled();
  });

  it("does not expose another member's prepared authorization", async () => {
    const jobs = tableBuilder(null);
    mocks.createServiceClient.mockReturnValue({ from: () => jobs });

    const response = await POST(new Request("http://localhost/api/portal/onchain/relay", {
      method: "POST",
      body: JSON.stringify({ invoice_id: 101, signature }),
    }));

    expect(response.status).toBe(404);
    expect(jobs.eq).toHaveBeenCalledWith("member_id", 7);
    expect(mocks.verifyTypedData).not.toHaveBeenCalled();
  });

  it("rejects a second, different authorization for the same invoice", async () => {
    const jobs = tableBuilder({ ...baseJob, signature, status: "signed" });
    mocks.createServiceClient.mockReturnValue({ from: () => jobs });

    const response = await POST(new Request("http://localhost/api/portal/onchain/relay", {
      method: "POST",
      body: JSON.stringify({ invoice_id: 101, signature: otherSignature }),
    }));

    expect(response.status).toBe(409);
    expect(mocks.verifyTypedData).not.toHaveBeenCalled();
    expect(mocks.processGaslessRelayQueue).not.toHaveBeenCalled();
  });
});
