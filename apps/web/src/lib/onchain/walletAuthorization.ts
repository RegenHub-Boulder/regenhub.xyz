import type { Address, Hex } from "viem";

export type RelayAuthorization = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: {
    TransferWithAuthorization: readonly { name: string; type: string }[];
  };
  primaryType: "TransferWithAuthorization";
  message: {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
};

export const WALLET_REQUEST_TIMEOUT_MS = 60_000;

export function relayAuthorizationRequest(authorization: RelayAuthorization) {
  return {
    domain: authorization.domain,
    types: authorization.types,
    primaryType: authorization.primaryType,
    message: {
      ...authorization.message,
      value: BigInt(authorization.message.value),
      validAfter: BigInt(authorization.message.validAfter),
      validBefore: BigInt(authorization.message.validBefore),
    },
  } as const;
}

export function authorizationExpiresAt(authorization: RelayAuthorization) {
  return new Date(Number(authorization.message.validBefore) * 1_000);
}

type ExpectedAuthorization = {
  from: Address;
  treasury: Address;
  token: Address;
  amountMicros: number;
  chainId: number;
};

export function assertExpectedAuthorization(
  authorization: RelayAuthorization,
  expected: ExpectedAuthorization,
) {
  const sameAddress = (left: Address, right: Address) => left.toLowerCase() === right.toLowerCase();
  if (
    authorization.primaryType !== "TransferWithAuthorization"
    || authorization.domain.chainId !== expected.chainId
    || !sameAddress(authorization.domain.verifyingContract, expected.token)
    || !sameAddress(authorization.message.from, expected.from)
    || !sameAddress(authorization.message.to, expected.treasury)
    || authorization.message.value !== String(expected.amountMicros)
  ) {
    throw new Error("The wallet authorization does not match this RegenHub invoice. Nothing was signed.");
  }
  return authorization;
}

export async function withWalletTimeout<T>(
  request: Promise<T>,
  message: string,
  timeoutMs = WALLET_REQUEST_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([request, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
