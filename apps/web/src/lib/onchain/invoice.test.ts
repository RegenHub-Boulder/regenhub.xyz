import { describe, expect, it } from "vitest";
import { addCalendarMonth, discountedCents, invoiceValues } from "./invoice";

describe("on-chain invoice math", () => {
  it("applies the 2.9% discount and rounds to cents", () => {
    expect(discountedCents(3_000)).toBe(2_913);
    expect(discountedCents(5_000)).toBe(4_855);
    expect(discountedCents(10_000)).toBe(9_710);
  });

  it("clamps month-end billing dates", () => {
    expect(addCalendarMonth("2026-01-31T17:00:00.000Z")).toBe("2026-02-28T17:00:00.000Z");
    expect(addCalendarMonth("2028-01-31T17:00:00.000Z")).toBe("2028-02-29T17:00:00.000Z");
  });

  it("freezes exact native-USDC micros and OP addresses", () => {
    expect(invoiceValues({
      subscriptionId: 7,
      memberId: 9,
      periodStart: "2026-09-01T00:00:00.000Z",
      baseAmountCents: 3_000,
    })).toMatchObject({
      amount_cents: 2_913,
      amount_usdc_micros: 29_130_000,
      chain_id: 10,
      token_contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      treasury_address: "0xA594263e0449A28eAEf5BA6420E81cC1996b7782",
    });
  });
});
