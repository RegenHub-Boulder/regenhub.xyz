import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeContract: vi.fn(),
  getBlockNumber: vi.fn(),
  getBlock: vi.fn(),
  readContract: vi.fn(),
  getLogs: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createWalletClient: () => ({ writeContract: mocks.writeContract }),
}));
vi.mock("./config", async (importOriginal) => ({
  ...await importOriginal<typeof import("./config")>(),
  getOpPublicClient: () => ({
    getBlockNumber: mocks.getBlockNumber,
    getBlock: mocks.getBlock,
    readContract: mocks.readContract,
    getLogs: mocks.getLogs,
  }),
  assertOpPublicClient: vi.fn(async () => undefined),
  getOpRelayerPrivateKey: () => `0x${"11".repeat(32)}`,
}));

import type { RelayJob } from "./gaslessRelay";
import { processGaslessRelayQueue } from "./gaslessRelay";

const txHash = `0x${"aa".repeat(32)}` as const;
const fromAddress = "0x1111111111111111111111111111111111111111";

function authorizationLog(eventName: "AuthorizationUsed" | "AuthorizationCanceled") {
  return {
    eventName,
    args: { authorizer: fromAddress, nonce: `0x${"ab".repeat(32)}` },
    transactionHash: txHash,
  };
}

function relayJob(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    invoice_id: 101,
    member_id: 7,
    wallet_id: 12,
    from_address: fromAddress,
    token_contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    treasury_address: "0xA594263e0449A28eAEf5BA6420E81cC1996b7782",
    amount_usdc_micros: 250_000_000,
    authorization_nonce: `0x${"ab".repeat(32)}`,
    valid_after: Math.floor(Date.now() / 1000) - 60,
    valid_before: Math.floor(Date.now() / 1000) + 1_800,
    signature: `0x${"22".repeat(65)}`,
    status: "signed",
    authorization_from_block: 139_999_900,
    submitted_tx_hash: null,
    attempts: 0,
    last_error: null,
    signed_at: new Date().toISOString(),
    submitted_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

type State = {
  worker: { lease_token: string | null; lease_claimed_at: string | null };
  job: RelayJob;
  invoice: Record<string, unknown>;
  subscription: Record<string, unknown>;
  wallet: Record<string, unknown>;
};

function fakeAdmin(state: State) {
  const from = vi.fn((table: string) => {
    let operation: "select" | "update" = "select";
    let updateValue: Record<string, unknown> | null = null;
    let selectAfterUpdate = false;
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => { selectAfterUpdate = operation === "update"; return chain; });
    chain.update = vi.fn((value: Record<string, unknown>) => {
      operation = "update";
      updateValue = value;
      return chain;
    });
    for (const method of ["eq", "neq", "is", "in", "or", "order", "limit"]) {
      chain[method] = vi.fn(() => chain);
    }

    const execute = async () => {
      if (operation === "update" && updateValue) {
        if (table === "onchain_relay_worker") {
          const claiming = Boolean(updateValue.lease_claimed_at);
          if (claiming && state.worker.lease_claimed_at) return { data: null, error: null };
          Object.assign(state.worker, updateValue);
          return { data: selectAfterUpdate ? { lease_token: state.worker.lease_token } : null, error: null };
        }
        if (table === "onchain_relay_jobs") Object.assign(state.job, updateValue);
        if (table === "onchain_invoices") Object.assign(state.invoice, updateValue);
        return { data: selectAfterUpdate ? { invoice_id: state.job.invoice_id } : null, error: null };
      }
      const data = table === "onchain_relay_worker" ? state.worker
        : table === "onchain_relay_jobs" ? state.job
          : table === "onchain_invoices" ? state.invoice
            : table === "subscriptions" ? state.subscription
              : table === "member_wallets" ? state.wallet
                : null;
      return { data, error: null };
    };
    chain.maybeSingle = vi.fn(execute);
    chain.single = vi.fn(execute);
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => execute().then(resolve, reject);
    return chain;
  });
  return { from };
}

function stateFor(job: RelayJob): State {
  return {
    worker: { lease_token: null, lease_claimed_at: null },
    job,
    invoice: {
      member_id: 7,
      subscription_id: 91,
      status: "open",
      submitted_tx_hash: null,
      amount_usdc_micros: 250_000_000,
      token_contract: job.token_contract,
      treasury_address: job.treasury_address,
    },
    subscription: { wallet_id: 12 },
    wallet: { address: fromAddress },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBlockNumber.mockResolvedValue(140_000_000n);
  mocks.getBlock.mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  mocks.readContract.mockResolvedValue(false);
  mocks.getLogs.mockResolvedValue([]);
  mocks.writeContract.mockResolvedValue(txHash);
});

describe("gasless relay queue", () => {
  it("serializes the worker and freezes the exact authorization into the relayer call", async () => {
    const state = stateFor(relayJob());
    const admin = fakeAdmin(state);

    const result = await processGaslessRelayQueue(admin as never, 101);

    expect(result).toEqual({ status: "submitted", invoiceId: 101, txHash });
    expect(mocks.writeContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "transferWithAuthorization",
      args: [
        fromAddress,
        state.job.treasury_address,
        250_000_000n,
        BigInt(state.job.valid_after),
        BigInt(state.job.valid_before),
        state.job.authorization_nonce,
        state.job.signature,
      ],
    }));
    expect(state.job.status).toBe("submitted");
    expect(state.invoice).toMatchObject({ status: "submitted", submitted_tx_hash: txHash });
    expect(state.worker).toEqual({ lease_token: null, lease_claimed_at: null });
  });

  it("recovers a broadcast after a crash by its indexed authorization nonce without sending twice", async () => {
    const state = stateFor(relayJob({
      status: "submitting",
      authorization_from_block: 139_999_900,
      attempts: 1,
    }));
    const admin = fakeAdmin(state);
    mocks.readContract.mockResolvedValue(true);
    mocks.getLogs.mockResolvedValue([authorizationLog("AuthorizationUsed")]);

    const result = await processGaslessRelayQueue(admin as never, 101);

    expect(result).toEqual({ status: "submitted", invoiceId: 101, txHash });
    expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({
      blockNumber: 140_000_000n,
    }));
    expect(mocks.getLogs).toHaveBeenCalledWith(expect.objectContaining({
      fromBlock: 139_999_900n,
      toBlock: 139_999_909n,
    }));
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });

  it("recovers a consumed authorization after its signing window expires instead of inviting a second payment", async () => {
    const state = stateFor(relayJob({
      status: "submitting",
      authorization_from_block: 1_000,
      valid_before: 1_025,
      attempts: 1,
    }));
    const admin = fakeAdmin(state);
    mocks.getBlockNumber.mockResolvedValue(1_100n);
    mocks.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: blockNumber,
    }));
    mocks.readContract.mockResolvedValue(true);
    mocks.getLogs.mockImplementation(async ({ fromBlock }: { fromBlock: bigint }) => (
      fromBlock === 1_020n
        ? [authorizationLog("AuthorizationUsed")]
        : []
    ));

    const result = await processGaslessRelayQueue(admin as never, 101);

    expect(result).toEqual({ status: "submitted", invoiceId: 101, txHash });
    expect(state.job.status).toBe("submitted");
    expect(state.invoice).toMatchObject({ status: "submitted", submitted_tx_hash: txHash });
    expect(mocks.getLogs).toHaveBeenCalledTimes(3);
    expect(mocks.getLogs).toHaveBeenLastCalledWith(expect.objectContaining({
      fromBlock: 1_020n,
      toBlock: 1_024n,
    }));
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });

  it("does not allocate a second relayer nonce while another worker lease is live", async () => {
    const state = stateFor(relayJob());
    state.worker = { lease_token: "other-worker", lease_claimed_at: new Date().toISOString() };
    const admin = fakeAdmin(state);

    await expect(processGaslessRelayQueue(admin as never, 101)).resolves.toEqual({ status: "busy" });
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });

  it("scans a consumed authorization in provider-safe ten-block chunks", async () => {
    const state = stateFor(relayJob({
      status: "submitting",
      authorization_from_block: 139_999_900,
      attempts: 1,
    }));
    const admin = fakeAdmin(state);
    mocks.readContract.mockResolvedValue(true);
    mocks.getLogs.mockImplementation(async ({ fromBlock }: { fromBlock: bigint }) => (
      fromBlock === 139_999_920n
        ? [authorizationLog("AuthorizationUsed")]
        : []
    ));

    const result = await processGaslessRelayQueue(admin as never, 101);

    expect(result).toEqual({ status: "submitted", invoiceId: 101, txHash });
    expect(mocks.getLogs).toHaveBeenCalledTimes(3);
    for (const [request] of mocks.getLogs.mock.calls) {
      expect(request.toBlock - request.fromBlock).toBeLessThanOrEqual(9n);
    }
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });

  it("expires a wallet-canceled authorization instead of retrying it forever", async () => {
    const state = stateFor(relayJob({ status: "submitting", attempts: 1 }));
    const admin = fakeAdmin(state);
    mocks.readContract.mockResolvedValue(true);
    mocks.getBlockNumber.mockResolvedValue(139_999_900n);
    mocks.getLogs.mockResolvedValue([authorizationLog("AuthorizationCanceled")]);

    await expect(processGaslessRelayQueue(admin as never, 101))
      .rejects.toThrow("authorization was canceled");
    expect(state.job.status).toBe("expired");
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });

  it("keeps a consumed authorization retryable when neither event is available yet", async () => {
    const state = stateFor(relayJob({ status: "submitting", attempts: 1 }));
    const admin = fakeAdmin(state);
    mocks.readContract.mockResolvedValue(true);
    mocks.getBlockNumber.mockResolvedValue(139_999_900n);
    mocks.getLogs.mockResolvedValue([]);

    await expect(processGaslessRelayQueue(admin as never, 101))
      .rejects.toThrow("event is not available yet");
    expect(state.job.status).toBe("submitting");
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });
});
