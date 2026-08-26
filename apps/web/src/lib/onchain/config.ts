import { createPublicClient, http } from "viem";
import { optimism } from "viem/chains";

export const ONCHAIN_CHAIN_ID = 10;
export const ONCHAIN_DISCOUNT_BPS = 290;
export const ONCHAIN_REMINDER_DAYS = 7;
export const NATIVE_USDC_ADDRESS = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as const;
export const TREASURY_ADDRESS = "0xA594263e0449A28eAEf5BA6420E81cC1996b7782" as const;

export function getOpPublicClient() {
  const rpcUrl = process.env.OP_RPC_URL;
  if (!rpcUrl) throw new Error("OP_RPC_URL is not configured");
  return createPublicClient({ chain: optimism, transport: http(rpcUrl) });
}

export function isOnchainBillingConfigured(): boolean {
  return Boolean(process.env.OP_RPC_URL);
}
