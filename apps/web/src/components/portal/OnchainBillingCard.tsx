"use client";

import { useCallback, useEffect, useState } from "react";
import { ConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import { getAddress, type Address, type Hash, type Hex } from "viem";
import {
  useAccount,
  useSignMessage,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, Wallet } from "lucide-react";
import { RegenHubWalletProvider } from "@/components/web3/RegenHubWalletProvider";

type Props = {
  walletAddress: string | null;
  walletVerifiedBySignature: boolean;
  invoice: {
    id: number;
    amountCents: number;
    amountMicros: number;
    dueAt: string;
    status: string;
    txHash: string | null;
  } | null;
  tokenAddress: Address;
  treasuryAddress: Address;
  configured: boolean;
};

type WalletAction = "verify" | "pay";

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

function OnchainBillingCardInner(props: Props) {
  const { address, connector, isConnected } = useAccount();
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<WalletAction | null>(null);
  const [connectModalSeen, setConnectModalSeen] = useState(false);
  const [submittedTxHash, setSubmittedTxHash] = useState<Hash | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connectAndVerify = useCallback(async () => {
    if (!address) return;
    setBusy(true); setError(null); setMessage("Confirm wallet ownership in your wallet…");
    try {
      const checksummed = getAddress(address);
      const challengeRes = await fetch("/api/portal/onchain/wallet/challenge", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: checksummed }),
      });
      const challenge = await challengeRes.json();
      if (!challengeRes.ok) throw new Error(challenge.error ?? "Could not create wallet challenge");
      const signature = await signMessageAsync({ account: checksummed, message: challenge.message });
      const verifyRes = await fetch("/api/portal/onchain/wallet/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_id: challenge.id, address: checksummed, signature }),
      });
      const verified = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verified.error ?? "Wallet verification failed");
      setMessage(`Verified ${checksummed.slice(0, 6)}…${checksummed.slice(-4)}. Refreshing…`);
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet verification failed");
      setMessage(null);
    } finally { setBusy(false); }
  }, [address, signMessageAsync]);

  const pay = useCallback(async () => {
    if (!props.invoice || !props.walletAddress || !address) return;
    let transferHash: Hash | null = null;
    setBusy(true); setError(null); setMessage("Authorize the exact USDC payment — RegenHub covers the OP gas…");
    try {
      const checksummed = getAddress(address);
      if (checksummed.toLowerCase() !== props.walletAddress.toLowerCase()) {
        throw new Error(`Connect the verified wallet ${props.walletAddress.slice(0, 8)}…${props.walletAddress.slice(-4)}`);
      }
      await switchChainAsync({ chainId: 10 });
      const prepareRes = await fetch("/api/portal/onchain/relay/prepare", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: props.invoice.id }),
      });
      const prepared = await prepareRes.json() as {
        status?: "prepared" | "queued" | "submitted";
        authorization?: RelayAuthorization;
        txHash?: Hash;
        error?: string;
      };
      if (!prepareRes.ok) throw new Error(prepared.error ?? "Could not prepare gasless payment");

      let signature: Hex | undefined;
      if (prepared.authorization) {
        const authorization = prepared.authorization;
        signature = await signTypedDataAsync({
          account: checksummed,
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

      let txHash = prepared.txHash ?? null;
      for (let attempt = 0; !txHash && attempt < 12; attempt += 1) {
        const relayRes = await fetch("/api/portal/onchain/relay", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invoice_id: props.invoice.id, signature }),
        });
        const relayed = await relayRes.json() as { txHash?: Hash; error?: string };
        if (!relayRes.ok && relayRes.status !== 202) {
          throw new Error(relayed.error ?? "Could not submit gasless payment");
        }
        txHash = relayed.txHash ?? null;
        signature = undefined;
        if (!txHash && attempt < 11) await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      if (!txHash) {
        throw new Error("Payment authorization is queued; RegenHub will keep retrying it. Do not authorize again.");
      }
      transferHash = txHash;
      setSubmittedTxHash(txHash);
      setMessage("Transaction submitted. RegenHub is checking OP confirmation…");
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const res = await fetch("/api/portal/onchain/submit", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invoice_id: props.invoice.id, tx_hash: txHash }),
        });
        const result = await res.json();
        if (!res.ok && res.status !== 202) throw new Error(result.error ?? "Could not track transaction");
        if (result.status === "paid") {
          setMessage("Payment confirmed — membership is active.");
          setTimeout(() => window.location.reload(), 1_500);
          return;
        }
        if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      setMessage("Payment submitted — confirmation will finish automatically.");
    } catch (cause) {
      setError(transferHash
        ? `${cause instanceof Error ? cause.message : "Confirmation is delayed"}. Your transaction was submitted; do not pay again.`
        : cause instanceof Error ? cause.message : "Payment could not be submitted");
      setMessage(null);
    } finally { setBusy(false); }
  }, [address, props.invoice, props.walletAddress, signTypedDataAsync, switchChainAsync]);

  useEffect(() => {
    if (!pendingAction || !isConnected || !address) return;
    const action = pendingAction;
    setPendingAction(null);
    setConnectModalSeen(false);
    void (action === "verify" ? connectAndVerify() : pay());
  }, [address, connectAndVerify, isConnected, pay, pendingAction]);

  useEffect(() => {
    if (!pendingAction) return;
    if (connectModalOpen) {
      setConnectModalSeen(true);
      return;
    }
    if (connectModalSeen && !isConnected) {
      setPendingAction(null);
      setConnectModalSeen(false);
    }
  }, [connectModalOpen, connectModalSeen, isConnected, pendingAction]);

  function begin(action: WalletAction) {
    setError(null); setMessage(null);
    if (isConnected && address) {
      void (action === "verify" ? connectAndVerify() : pay());
      return;
    }
    setPendingAction(action);
    setConnectModalSeen(false);
    openConnectModal?.();
  }

  return (
    <div className="glass-panel border border-sage/20 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Wallet className="w-4 h-4 text-sage" />
        <p className="font-medium text-sm">Pay direct to the RegenHub treasury</p>
      </div>
      <p className="text-xs text-muted">Native USDC on OP Mainnet · same membership rate · RegenHub sponsors the gas and your wallet authorizes the exact payment.</p>

      {isConnected && address && (
        <ConnectButton.Custom>
          {({ account, openAccountModal }) => account && (
            <button type="button" onClick={openAccountModal} className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs hover:bg-white/10 transition-colors">
              {connector?.name ?? "Wallet"} · {account.displayName}
            </button>
          )}
        </ConnectButton.Custom>
      )}

      {!props.walletVerifiedBySignature ? (
        <Button disabled={busy} onClick={() => begin("verify")} className="btn-glass text-xs gap-2">
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Connect & verify wallet
        </Button>
      ) : props.invoice && props.invoice.status !== "paid" ? (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm">
            <p className="font-medium">${(props.invoice.amountCents / 100).toFixed(2)} USDC</p>
            <p className="text-xs text-muted">Due {new Date(props.invoice.dueAt).toLocaleDateString()}</p>
          </div>
          <Button disabled={busy || Boolean(submittedTxHash) || !props.configured || ["submitted", "detected"].includes(props.invoice.status)} onClick={() => begin("pay")} className="bg-sage/20 hover:bg-sage/40 text-sage border border-sage/30 text-xs gap-2">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {["submitted", "detected"].includes(props.invoice.status) ? "Confirming…" : "Review & pay"}
          </Button>
        </div>
      ) : props.invoice?.status === "paid" ? (
        <p className="text-xs text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Payment confirmed.</p>
      ) : (
        <p className="text-xs text-emerald-400">Wallet verified. Your next invoice appears here seven days before renewal.</p>
      )}
      {props.walletAddress && <p className="text-[11px] text-muted font-mono break-all">Verified wallet: {props.walletAddress}</p>}
      {props.invoice?.txHash && <a className="text-xs text-sage underline" href={`https://optimistic.etherscan.io/tx/${props.invoice.txHash}`} target="_blank" rel="noreferrer">View transaction</a>}
      {submittedTxHash && !props.invoice?.txHash && <a className="text-xs text-sage underline" href={`https://optimistic.etherscan.io/tx/${submittedTxHash}`} target="_blank" rel="noreferrer">View submitted transaction</a>}
      {message && <p className="text-xs text-emerald-400">{message}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

export function OnchainBillingCard(props: Props) {
  return (
    <RegenHubWalletProvider>
      <OnchainBillingCardInner {...props} />
    </RegenHubWalletProvider>
  );
}
