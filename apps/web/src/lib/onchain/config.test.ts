import { describe, expect, it } from "vitest";
import { assertOpChainId } from "./config";

describe("OP RPC chain assertion", () => {
  it("accepts OP Mainnet chain 10", () => {
    expect(() => assertOpChainId(10)).not.toThrow();
  });

  it("fails closed for another EVM chain", () => {
    expect(() => assertOpChainId(1)).toThrow("returned chain 1; expected 10");
  });
});
