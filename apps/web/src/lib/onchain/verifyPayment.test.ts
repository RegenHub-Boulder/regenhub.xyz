import { describe, expect, it } from "vitest";
import type { Address, Log } from "viem";
import {
  canClaimPaymentEffects,
  selectExpectedTransfer,
  type DecodedTransfer,
} from "./verifyPayment";

const expected = {
  token: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  from: "0x1111111111111111111111111111111111111111",
  to: "0xA594263e0449A28eAEf5BA6420E81cC1996b7782",
  amount: 29_130_000n,
};

function transfer(overrides: Partial<DecodedTransfer> = {}): DecodedTransfer {
  return {
    logIndex: 3,
    from: expected.from as Address,
    to: expected.to as Address,
    amount: expected.amount,
    address: expected.token as Address,
    raw: {} as Log,
    ...overrides,
  };
}

describe("selectExpectedTransfer", () => {
  it("selects one exact sender/token/treasury/amount match", () => {
    expect(selectExpectedTransfer([transfer()], expected).logIndex).toBe(3);
  });

  it("rejects wrong senders and amounts", () => {
    expect(() => selectExpectedTransfer([
      transfer({ from: "0x2222222222222222222222222222222222222222" }),
    ], expected)).toThrow("no exact expected");
    expect(() => selectExpectedTransfer([transfer({ amount: 29_129_999n })], expected))
      .toThrow("no exact expected");
  });

  it("rejects an ambiguous transaction with duplicate exact transfers", () => {
    expect(() => selectExpectedTransfer([transfer(), transfer({ logIndex: 4 })], expected))
      .toThrow("multiple matching");
  });
});

describe("payment effects claim lease", () => {
  const now = new Date("2026-08-26T20:00:00.000Z");

  it("allows an unclaimed payment and rejects a completed one", () => {
    expect(canClaimPaymentEffects({ effects_claimed_at: null, effects_completed_at: null }, now)).toBe(true);
    expect(canClaimPaymentEffects({
      effects_claimed_at: null,
      effects_completed_at: "2026-08-26T19:59:00.000Z",
    }, now)).toBe(false);
  });

  it("keeps a live worker's claim and permits crash recovery after five minutes", () => {
    expect(canClaimPaymentEffects({
      effects_claimed_at: "2026-08-26T19:59:00.000Z",
      effects_completed_at: null,
    }, now)).toBe(false);
    expect(canClaimPaymentEffects({
      effects_claimed_at: "2026-08-26T19:55:00.000Z",
      effects_completed_at: null,
    }, now)).toBe(true);
  });
});
