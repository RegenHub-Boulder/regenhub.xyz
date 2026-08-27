import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePortalMember: vi.fn(),
  createServiceClient: vi.fn(),
  getBlockNumber: vi.fn(),
  readContract: vi.fn(),
}));

vi.mock("@/lib/onchain/portalMember", () => ({ requirePortalMember: mocks.requirePortalMember }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock("@/lib/onchain/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/onchain/config")>(),
  isGaslessRelayConfigured: () => true,
  getOpPublicClient: () => ({ getBlockNumber: mocks.getBlockNumber, readContract: mocks.readContract }),
  assertOpPublicClient: vi.fn(async () => undefined),
}));

import { POST } from "./route";

const invoice = {
  id: 101,
  member_id: 7,
  subscription_id: 91,
  status: "open",
  submitted_tx_hash: null,
  amount_usdc_micros: 250_000_000,
  chain_id: 10,
  token_contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  treasury_address: "0xA594263e0449A28eAEf5BA6420E81cC1996b7782",
};

function selectBuilder(data: unknown) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "is"]) chain[method] = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({ data, error: null }));
  chain.maybeSingle = vi.fn(async () => ({ data, error: null }));
  return chain;
}

function jobsBuilder(existing: unknown = null) {
  let inserted: Record<string, unknown> | null = null;
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq"]) chain[method] = vi.fn(() => chain);
  chain.upsert = vi.fn((value: Record<string, unknown>) => {
    inserted = value;
    return chain;
  });
  chain.maybeSingle = vi.fn(async () => ({ data: existing, error: null }));
  chain.single = vi.fn(async () => ({
    data: inserted ? {
      ...inserted,
      created_at: "2026-08-27T04:00:00.000Z",
      updated_at: "2026-08-27T04:00:00.000Z",
    } : existing,
    error: null,
  }));
  return { chain, inserted: () => inserted };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePortalMember.mockResolvedValue({
    user: { id: "auth-1" },
    member: { id: 7, disabled: false },
  });
  mocks.getBlockNumber.mockResolvedValue(140_000_000n);
  mocks.readContract.mockResolvedValue(500_000_000n);
});
describe("POST /api/portal/onchain/relay/prepare", () => {
  it("builds authorization only from the member's frozen invoice and verified wallet", async () => {
    const jobs = jobsBuilder();
    const tables = {
      onchain_invoices: selectBuilder(invoice),
      subscriptions: selectBuilder({ wallet_id: 12, payment_rail: "onchain" }),
      member_wallets: selectBuilder({ address: "0x1111111111111111111111111111111111111111" }),
      onchain_relay_jobs: jobs.chain,
    };
    mocks.createServiceClient.mockReturnValue({
      from: (table: keyof typeof tables) => tables[table],
    });

    const response = await POST(new Request("http://localhost/api/portal/onchain/relay/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invoice_id: 101,
        amount: 1,
        treasury: "0x2222222222222222222222222222222222222222",
      }),
    }));

    expect(response.status).toBe(200);
    expect(jobs.inserted()).toMatchObject({
      invoice_id: 101,
      member_id: 7,
      wallet_id: 12,
      from_address: "0x1111111111111111111111111111111111111111",
      token_contract: invoice.token_contract,
      treasury_address: invoice.treasury_address,
      amount_usdc_micros: 250_000_000,
      authorization_from_block: 140_000_000,
      status: "prepared",
    });
    await expect(response.json()).resolves.toMatchObject({
      status: "prepared",
      authorization: {
        domain: { name: "USD Coin", version: "2", chainId: 10, verifyingContract: invoice.token_contract },
        message: {
          from: "0x1111111111111111111111111111111111111111",
          to: invoice.treasury_address,
          value: "250000000",
        },
      },
    });
  });

  it("fails closed if a stored invoice points away from native USDC", async () => {
    const invoices = selectBuilder({
      ...invoice,
      token_contract: "0x2222222222222222222222222222222222222222",
    });
    const from = vi.fn((table: string) => table === "onchain_invoices" ? invoices : selectBuilder(null));
    mocks.createServiceClient.mockReturnValue({ from });

    const response = await POST(new Request("http://localhost/api/portal/onchain/relay/prepare", {
      method: "POST",
      body: JSON.stringify({ invoice_id: 101 }),
    }));

    expect(response.status).toBe(409);
    expect(from).not.toHaveBeenCalledWith("onchain_relay_jobs");
  });

  it("reports the exact native OP USDC shortfall before requesting a signature", async () => {
    const jobs = jobsBuilder();
    const tables = {
      onchain_invoices: selectBuilder(invoice),
      subscriptions: selectBuilder({ wallet_id: 12, payment_rail: "onchain" }),
      member_wallets: selectBuilder({ address: "0x1111111111111111111111111111111111111111" }),
      onchain_relay_jobs: jobs.chain,
    };
    mocks.createServiceClient.mockReturnValue({
      from: (table: keyof typeof tables) => tables[table],
    });
    mocks.readContract.mockResolvedValue(3_858_523n);

    const response = await POST(new Request("http://localhost/api/portal/onchain/relay/prepare", {
      method: "POST",
      body: JSON.stringify({ invoice_id: 101 }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This wallet has 3.858523 native USDC on OP Mainnet, but this payment requires 250. Add 246.141477 USDC to this wallet before authorizing.",
      code: "insufficient_usdc_balance",
      balance_usdc_micros: "3858523",
      required_usdc_micros: "250000000",
      shortfall_usdc_micros: "246141477",
    });
    expect(jobs.chain.upsert).not.toHaveBeenCalled();
  });

  it("does not overwrite an expired signed job before the worker can recover a consumed authorization", async () => {
    const existing = {
      invoice_id: 101,
      member_id: 7,
      wallet_id: 12,
      from_address: "0x1111111111111111111111111111111111111111",
      token_contract: invoice.token_contract,
      treasury_address: invoice.treasury_address,
      amount_usdc_micros: invoice.amount_usdc_micros,
      authorization_nonce: `0x${"ab".repeat(32)}`,
      valid_after: 1,
      valid_before: 2,
      signature: `0x${"11".repeat(65)}`,
      status: "submitting",
      authorization_from_block: 139_999_900,
      submitted_tx_hash: null,
    };
    const jobs = jobsBuilder(existing);
    const tables = {
      onchain_invoices: selectBuilder(invoice),
      subscriptions: selectBuilder({ wallet_id: 12, payment_rail: "onchain" }),
      member_wallets: selectBuilder({ address: "0x1111111111111111111111111111111111111111" }),
      onchain_relay_jobs: jobs.chain,
    };
    mocks.createServiceClient.mockReturnValue({
      from: (table: keyof typeof tables) => tables[table],
    });

    const response = await POST(new Request("http://localhost/api/portal/onchain/relay/prepare", {
      method: "POST",
      body: JSON.stringify({ invoice_id: 101 }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "queued" });
    expect(jobs.chain.upsert).not.toHaveBeenCalled();
    expect(mocks.readContract).not.toHaveBeenCalled();
  });
});
