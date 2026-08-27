import type { Hash } from "viem";

export const CONFIRMATION_POLL_ATTEMPTS = 72;
export const CONFIRMATION_POLL_INTERVAL_MS = 5_000;

type PollOptions = {
  invoiceId: number;
  txHash: Hash;
  signal?: AbortSignal;
  attempts?: number;
  intervalMs?: number;
};

export async function pollOnchainPayment({
  invoiceId,
  txHash,
  signal,
  attempts = CONFIRMATION_POLL_ATTEMPTS,
  intervalMs = CONFIRMATION_POLL_INTERVAL_MS,
}: PollOptions) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch("/api/portal/onchain/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_id: invoiceId, tx_hash: txHash }),
      signal,
    });
    const result = await response.json();
    if (!response.ok && response.status !== 202) {
      throw new Error(result.error ?? "Could not track the transaction");
    }
    if (result.status === "paid") return true;
    if (attempt < attempts - 1) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          globalThis.clearTimeout(timeout);
          reject(signal?.reason);
        };
        const timeout = globalThis.setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, intervalMs);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  return false;
}
