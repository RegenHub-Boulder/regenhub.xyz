import { describe, expect, it } from "vitest";
import type { Address, Log } from "viem";
import { selectExpectedTransfer, type DecodedTransfer } from "./verifyPayment";

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
