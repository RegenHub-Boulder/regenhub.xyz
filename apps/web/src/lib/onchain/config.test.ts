import { afterEach, describe, expect, it } from "vitest";
import {
  assertOpChainId,
  getOpRelayerPrivateKey,
  isGaslessRelayConfigured,
} from "./config";
const oldEnv = { ...process.env };

afterEach(() => { process.env = { ...oldEnv }; });

describe("OP RPC chain assertion", () => {
  it("accepts OP Mainnet chain 10", () => {
    expect(() => assertOpChainId(10)).not.toThrow();
  });

  it("fails closed for another EVM chain", () => {
    expect(() => assertOpChainId(1)).toThrow("returned chain 1; expected 10");
  });
});

describe("gasless relayer configuration", () => {
  it("requires both the RPC and an exact 32-byte private key", () => {
    process.env.OP_RPC_URL = "https://op.example";
    process.env.OP_RELAYER_PRIVATE_KEY = "0x1234";
    expect(isGaslessRelayConfigured()).toBe(false);
    expect(() => getOpRelayerPrivateKey()).toThrow("not configured");

    process.env.OP_RELAYER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    expect(isGaslessRelayConfigured()).toBe(true);
    expect(getOpRelayerPrivateKey()).toBe(process.env.OP_RELAYER_PRIVATE_KEY);
  });
});
