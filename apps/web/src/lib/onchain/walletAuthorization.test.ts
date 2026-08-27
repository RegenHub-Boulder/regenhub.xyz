import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayAuthorization } from "./walletAuthorization";
import {
  assertExpectedAuthorization,
  authorizationExpiresAt,
  relayAuthorizationRequest,
  withWalletTimeout,
} from "./walletAuthorization";

const authorization: RelayAuthorization = {
  domain: {
    name: "USD Coin",
    version: "2",
    chainId: 10,
    verifyingContract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: {
    from: "0x1111111111111111111111111111111111111111",
    to: "0xA594263e0449A28eAEf5BA6420E81cC1996b7782",
    value: "250000000",
    validAfter: "1787869263",
    validBefore: "1787871123",
    nonce: `0x${"ab".repeat(32)}`,
  },
};

afterEach(() => vi.useRealTimers());

describe("wallet authorization helpers", () => {
  it("converts only EIP-712 integer fields to bigint", () => {
    expect(relayAuthorizationRequest(authorization)).toEqual({
      domain: authorization.domain,
      types: authorization.types,
      primaryType: "TransferWithAuthorization",
      message: {
        ...authorization.message,
        value: 250000000n,
        validAfter: 1787869263n,
        validBefore: 1787871123n,
      },
    });
  });

  it("exposes the server-defined authorization expiry", () => {
    expect(authorizationExpiresAt(authorization).toISOString()).toBe("2026-08-27T22:52:03.000Z");
  });

  it("accepts only the exact wallet, token, treasury, chain, and amount", () => {
    expect(assertExpectedAuthorization(authorization, {
      from: authorization.message.from,
      treasury: authorization.message.to,
      token: authorization.domain.verifyingContract,
      amountMicros: 250_000_000,
      chainId: 10,
    })).toBe(authorization);

    expect(() => assertExpectedAuthorization(authorization, {
      from: authorization.message.from,
      treasury: authorization.message.to,
      token: authorization.domain.verifyingContract,
      amountMicros: 30_000_000,
      chainId: 10,
    })).toThrow("does not match this RegenHub invoice");
  });

  it("bounds a wallet request that never settles", async () => {
    vi.useFakeTimers();
    const result = withWalletTimeout(new Promise<never>(() => undefined), "Open MetaMask", 1_000);
    const rejection = expect(result).rejects.toThrow("Open MetaMask");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
  });
});
