import { createPublicClient, http, type Hex } from "viem";
import { optimism } from "viem/chains";

export const ONCHAIN_CHAIN_ID = 10;
// Kept configurable so a rail-specific discount can be reintroduced later.
export const ONCHAIN_DISCOUNT_BPS = 0;
export const ONCHAIN_REMINDER_DAYS = 7;
export const NATIVE_USDC_ADDRESS = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as const;
export const TREASURY_ADDRESS = "0xA594263e0449A28eAEf5BA6420E81cC1996b7782" as const;

const verifiedRpcUrls = new Set<string>();
const rpcVerificationByUrl = new Map<string, Promise<void>>();

export function assertOpChainId(chainId: number) {
  if (chainId !== ONCHAIN_CHAIN_ID) {
    throw new Error(`OP_RPC_URL returned chain ${chainId}; expected ${ONCHAIN_CHAIN_ID}`);
  }
}

export function getOpPublicClient() {
  const rpcUrl = process.env.OP_RPC_URL;
  if (!rpcUrl) throw new Error("OP_RPC_URL is not configured");
  return createPublicClient({ chain: optimism, transport: http(rpcUrl) });
}

/** Fail closed when OP_RPC_URL is accidentally pointed at another EVM chain. */
export async function assertOpPublicClient(
  client: ReturnType<typeof getOpPublicClient>,
) {
  const rpcUrl = process.env.OP_RPC_URL;
  if (!rpcUrl) throw new Error("OP_RPC_URL is not configured");
  if (verifiedRpcUrls.has(rpcUrl)) return;

  let verification = rpcVerificationByUrl.get(rpcUrl);
  if (!verification) {
    verification = client.getChainId()
      .then((chainId) => assertOpChainId(chainId))
      .then(() => { verifiedRpcUrls.add(rpcUrl); });
    rpcVerificationByUrl.set(rpcUrl, verification);
  }
  try {
    await verification;
  } finally {
    rpcVerificationByUrl.delete(rpcUrl);
  }
}

export function isOnchainBillingConfigured(): boolean {
  return Boolean(process.env.OP_RPC_URL);
}

export function getOpRelayerPrivateKey(): Hex {
  const value = process.env.OP_RELAYER_PRIVATE_KEY;
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("OP_RELAYER_PRIVATE_KEY is not configured");
  }
  return value as Hex;
}

export function isGaslessRelayConfigured(): boolean {
  return Boolean(process.env.OP_RPC_URL && /^0x[0-9a-fA-F]{64}$/.test(process.env.OP_RELAYER_PRIVATE_KEY ?? ""));
}
