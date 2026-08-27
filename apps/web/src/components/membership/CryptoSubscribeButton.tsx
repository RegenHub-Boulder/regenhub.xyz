"use client";

import { useCallback, useEffect, useState } from "react";
import { ConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import { type Address, type Hash, type Hex } from "viem";
import {
  useAccount,
  useSignMessage,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, Wallet } from "lucide-react";
import { RegenHubWalletProvider } from "@/components/web3/RegenHubWalletProvider";
import { pollOnchainPayment } from "@/lib/onchain/clientConfirmation";

type Setup = {
  subscription_id: number;
  invoice: {
    id: number;
    amount_cents: number;
    amount_usdc_micros: number;
    due_at: string;
    status: string;
    submitted_tx_hash?: Hash | null;
  };
  payment: {
    chain_id: number;
    token_address: Address;
    treasury_address: Address;
  };
};

type Phase = "idle" | "connecting" | "verifying" | "preparing" | "sending" | "confirming" | "received" | "complete";

type RelayAuthorization = {
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

const PENDING_PAYMENT_KEY = "regenhub:onchain:pending-payment";

type Props = {
  planKey: string;
  className?: string;
};

const PHASE_LABELS: Record<Exclude<Phase, "idle" | "complete">, string> = {
  connecting: "Connecting wallet…",
  verifying: "Verifying wallet ownership…",
  preparing: "Preparing your membership invoice…",
  sending: "Authorizing gasless USDC payment…",
  confirming: "Confirming on OP Mainnet…",
  received: "Payment received",
};

function CryptoSubscribeButtonInner({ planKey, className }: Props) {
  const { address, connector, isConnected } = useAccount();
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const [phase, setPhase] = useState<Phase>("idle");
  const [connectIntent, setConnectIntent] = useState(false);
  const [connectModalSeen, setConnectModalSeen] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [txHash, setTxHash] = useState<Hash | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirmSubmittedPayment = useCallback(async (invoiceId: number, hash: Hash) => {
    setTxHash(hash);
    setPhase("confirming");
    sessionStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify({ invoiceId, hash }));
    try {
      const paid = await pollOnchainPayment({
        invoiceId,
        txHash: hash,
        onStatus: (status) => {
          if (status === "detected") setPhase("received");
        },
      });
      if (paid) {
        sessionStorage.removeItem(PENDING_PAYMENT_KEY);
        setPhase("complete");
        setTimeout(() => { window.location.href = "/portal?onchain=paid"; }, 1_500);
      } else {
        setError("OP safe confirmation is taking longer than expected. Your transaction was submitted; do not pay again. Use Check payment confirmation to resume.");
        setPhase("idle");
      }
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "Confirmation is delayed"}. Your transaction was submitted; do not pay again. RegenHub will keep checking it.`);
      setPhase("idle");
    }
  }, []);

  const sendPayment = useCallback(async (nextSetup: Setup) => {
    if (!address) throw new Error("Connect your wallet to continue.");
    setPhase("sending");
    await switchChainAsync({ chainId: nextSetup.payment.chain_id });
    const prepareRes = await fetch("/api/portal/onchain/relay/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_id: nextSetup.invoice.id }),
    });
    const prepared = await prepareRes.json() as {
      status?: "prepared" | "queued" | "submitted";
      authorization?: RelayAuthorization;
      txHash?: Hash;
      error?: string;
    };
    if (!prepareRes.ok) throw new Error(prepared.error ?? "Could not prepare gasless payment");
    if (prepared.txHash) {
      await confirmSubmittedPayment(nextSetup.invoice.id, prepared.txHash);
      return;
    }

    let signature: Hex | undefined;
    if (prepared.authorization) {
      const authorization = prepared.authorization;
      signature = await signTypedDataAsync({
        account: address,
        domain: authorization.domain,
        types: authorization.types,
        primaryType: authorization.primaryType,
        message: {
          ...authorization.message,
          value: BigInt(authorization.message.value),
          validAfter: BigInt(authorization.message.validAfter),
          validBefore: BigInt(authorization.message.validBefore),
        },
      });
    }

    const relayRes = await fetch("/api/portal/onchain/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_id: nextSetup.invoice.id, signature }),
    });
    const relayed = await relayRes.json() as {
      status?: string;
      txHash?: Hash;
      error?: string;
      warning?: string;
    };
    if (!relayRes.ok && relayRes.status !== 202) {
      throw new Error(relayed.error ?? "Could not submit gasless payment");
    }
    if (relayed.txHash) {
      await confirmSubmittedPayment(nextSetup.invoice.id, relayed.txHash);
      return;
    }
    throw new Error(relayed.warning ?? "Payment authorization is queued; RegenHub will keep retrying it. Do not authorize again.");
  }, [address, confirmSubmittedPayment, signTypedDataAsync, switchChainAsync]);

  const verifyAndPay = useCallback(async () => {
    if (!address) return;
    setError(null);
    try {
      setPhase("verifying");
      const challengeRes = await fetch("/api/portal/onchain/wallet/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const challenge = await challengeRes.json();
      if (!challengeRes.ok) throw new Error(challenge.error ?? "Could not create wallet challenge");

      const signature = await signMessageAsync({ account: address, message: challenge.message });
      const verifyRes = await fetch("/api/portal/onchain/wallet/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_id: challenge.id, address, signature }),
      });
      const verified = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verified.error ?? "Wallet verification failed");

      setPhase("preparing");
      const setupRes = await fetch("/api/membership/onchain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_key: planKey }),
      });
      const nextSetup = await setupRes.json() as Setup & { error?: string };
      if (!setupRes.ok) throw new Error(nextSetup.error ?? "Could not start crypto membership");
      setSetup(nextSetup);
      const pending = (() => {
        try {
          return JSON.parse(sessionStorage.getItem(PENDING_PAYMENT_KEY) ?? "null") as { invoiceId?: number; hash?: Hash } | null;
        } catch {
          return null;
        }
      })();
      const pendingHash = nextSetup.invoice.submitted_tx_hash
        ?? (pending?.invoiceId === nextSetup.invoice.id && pending.hash?.match(/^0x[0-9a-fA-F]{64}$/) ? pending.hash : null);
      if (pendingHash) {
        await confirmSubmittedPayment(nextSetup.invoice.id, pendingHash);
        return;
      }
      await sendPayment(nextSetup);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start crypto membership");
      setPhase("idle");
    }
  }, [address, confirmSubmittedPayment, planKey, sendPayment, signMessageAsync]);

  useEffect(() => {
    if (!connectIntent || !isConnected || !address) return;
    setConnectIntent(false);
    setConnectModalSeen(false);
    void verifyAndPay();
  }, [address, connectIntent, isConnected, verifyAndPay]);

  useEffect(() => {
    if (!connectIntent) return;
    if (connectModalOpen) {
      setConnectModalSeen(true);
      return;
    }
    if (connectModalSeen && !isConnected) {
      setConnectIntent(false);
      setConnectModalSeen(false);
      setPhase("idle");
    }
  }, [connectIntent, connectModalOpen, connectModalSeen, isConnected]);

  function start() {
    setError(null);
    if (isConnected && address) {
      void verifyAndPay();
      return;
    }
    setConnectIntent(true);
    setConnectModalSeen(false);
    setPhase("connecting");
    openConnectModal?.();
  }

  const busy = phase !== "idle" && phase !== "complete";
  const amountCents = setup?.invoice.amount_cents ?? 25_000;

  return (
    <div className="space-y-2">
      <Button
        type="button"
        onClick={setup ? () => void sendPayment(setup).catch((cause) => {
          setError(cause instanceof Error ? cause.message : "Payment could not be submitted");
          setPhase("idle");
        }) : start}
        disabled={busy || phase === "complete"}
        className={className ?? "btn-glass w-full gap-2"}
      >
        {phase === "complete" || phase === "received" ? <CheckCircle2 className="w-4 h-4" /> : busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
        {phase === "complete" ? "Payment confirmed" : busy ? PHASE_LABELS[phase as Exclude<Phase, "idle" | "complete">] : txHash ? "Check payment confirmation" : setup ? `Retry $${(amountCents / 100).toFixed(2)} USDC payment` : "Pay with crypto"}
      </Button>

      {isConnected && address && (
        <ConnectButton.Custom>
          {({ account, openAccountModal }) => account && (
            <button type="button" onClick={openAccountModal} className="w-full text-[11px] text-muted hover:text-foreground transition-colors">
              {connector?.name ?? "Wallet"} · {account.displayName} · change
            </button>
          )}
        </ConnectButton.Custom>
      )}

      {setup && phase !== "complete" && (
        <div className="rounded-lg border border-sage/20 bg-sage/5 p-3 text-left space-y-1">
          <p className="text-xs font-medium">${(amountCents / 100).toFixed(2)} USDC · OP Mainnet</p>
          <p className="text-[11px] text-muted">Direct to the RegenHub treasury. Access begins only after server verification.</p>
          {txHash && <a href={`https://optimistic.etherscan.io/tx/${txHash}`} target="_blank" rel="noreferrer" className="text-[11px] text-sage underline">View submitted transaction</a>}
        </div>
      )}
      {phase === "complete" && <p className="text-xs text-emerald-400">Payment confirmed. Opening your member portal…</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

export function CryptoSubscribeButton(props: Props) {
  return (
    <RegenHubWalletProvider>
      <CryptoSubscribeButtonInner {...props} />
    </RegenHubWalletProvider>
  );
}
