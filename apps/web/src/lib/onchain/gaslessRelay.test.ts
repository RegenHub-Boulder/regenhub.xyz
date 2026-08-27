import { describe, expect, it } from "vitest";
import type { RelayJob } from "./gaslessRelay";
import { assertRelayJobMatchesConfig, authorizationTypedData, publicAuthorization } from "./gaslessRelay";

const job = {
  invoice_id: 101,
  member_id: 7,
  wallet_id: 12,
  from_address: "0x1111111111111111111111111111111111111111",
  token_contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  treasury_address: "0xA594263e0449A28eAEf5BA6420E81cC1996b7782",
  amount_usdc_micros: 250_000_000,
  authorization_nonce: `0x${"ab".repeat(32)}`,
  valid_after: 1_788_000_000,
  valid_before: 1_788_001_800,
  signature: null,
  status: "prepared",
  authorization_from_block: 139_999_900,
  submitted_tx_hash: null,
  attempts: 0,
  last_error: null,
  signed_at: null,
  submitted_at: null,
  created_at: "2026-08-27T04:00:00.000Z",
  updated_at: "2026-08-27T04:00:00.000Z",
} satisfies RelayJob;

describe("EIP-3009 transfer authorization", () => {
  it("binds the signature to native USDC on OP and the frozen invoice values", () => {
    const typed = authorizationTypedData(job);
    expect(typed).toMatchObject({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 10,
        verifyingContract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: job.from_address,
        to: job.treasury_address,
        value: 250_000_000n,
        validAfter: 1_788_000_000n,
        validBefore: 1_788_001_800n,
        nonce: job.authorization_nonce,
      },
    });
  });

  it("serializes bigint fields without changing their signed values", () => {
    const publicData = publicAuthorization(job);
    expect(publicData.message.value).toBe("250000000");
    expect(publicData.message.validAfter).toBe("1788000000");
    expect(publicData.message.validBefore).toBe("1788001800");
  });

  it("fails closed if a stored job no longer targets native USDC and the configured treasury", () => {
    expect(() => assertRelayJobMatchesConfig({
      token_contract: "0x2222222222222222222222222222222222222222",
      treasury_address: job.treasury_address,
    })).toThrow("token does not match");
    expect(() => assertRelayJobMatchesConfig({
      token_contract: job.token_contract,
      treasury_address: "0x2222222222222222222222222222222222222222",
    })).toThrow("treasury does not match");
  });
});
