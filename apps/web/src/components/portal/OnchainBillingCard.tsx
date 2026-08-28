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
import { GaslessPaymentReview } from "@/components/web3/GaslessPaymentReview";
import { pollOnchainPayment } from "@/lib/onchain/clientConfirmation";
import {
  assertExpectedAuthorization,
  relayAuthorizationRequest,
  shouldUseMetaMaskConnectForAuthorization,
  signAuthorizationWithMetaMaskConnect,
  type RelayAuthorization,
  withWalletTimeout,
} from "@/lib/onchain/walletAuthorization";

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

function OnchainBillingCardInner(props: Props) {
  const { address, chainId, connector, isConnected } = useAccount();
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<WalletAction | null>(null);
  const [connectModalSeen, setConnectModalSeen] = useState(false);
  const [authorization, setAuthorization] = useState<RelayAuthorization | null>(null);
  const [submittedTxHash, setSubmittedTxHash] = useState<Hash | null>(null);
  const [paymentDetected, setPaymentDetected] = useState(props.invoice?.status === "detected");
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
      const signature = await withWalletTimeout(
        signMessageAsync({ account: checksummed, message: challenge.message }),
        "MetaMask did not respond to the ownership check. Open MetaMask and cancel any request still waiting there before trying again.",
      );
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

  const confirmPayment = useCallback(async (txHash: Hash) => {
    if (!props.invoice) return;
    setSubmittedTxHash(txHash);
    setAuthorization(null);
    setMessage("Transaction submitted. RegenHub is checking OP confirmation…");
    if (await pollOnchainPayment({
      invoiceId: props.invoice.id,
      txHash,
      onStatus: (status) => {
        if (status === "detected") {
          setPaymentDetected(true);
          setMessage("Payment received. RegenHub is completing OP verification…");
        }
      },
    })) {
      setMessage("Payment confirmed — membership is active.");
      setTimeout(() => window.location.reload(), 1_500);
      return;
    }
    setMessage("Payment is still being verified. Do not pay again; reopen this page to resume checking.");
  }, [props.invoice]);

  const submitPayment = useCallback(async (signature?: Hex) => {
    if (!props.invoice) return;
    setMessage("Submitting the authorized payment — RegenHub covers the OP gas…");
    const relayRes = await fetch("/api/portal/onchain/relay", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_id: props.invoice.id, signature }),
    });
    const relayed = await relayRes.json() as { txHash?: Hash; error?: string; warning?: string };
    if (!relayRes.ok && relayRes.status !== 202) {
      throw new Error(relayed.error ?? "Could not submit gasless payment");
    }
    if (!relayed.txHash) {
      throw new Error(relayed.warning ?? "Payment authorization is queued; RegenHub will keep retrying it. Do not authorize again.");
    }
    await confirmPayment(relayed.txHash);
  }, [confirmPayment, props.invoice]);

  const preparePayment = useCallback(async () => {
    if (!props.invoice || !props.walletAddress || !address) return;
    setBusy(true); setError(null); setAuthorization(null);
    try {
      const checksummed = getAddress(address);
      if (checksummed.toLowerCase() !== props.walletAddress.toLowerCase()) {
        throw new Error(`Connect the verified wallet ${props.walletAddress.slice(0, 8)}…${props.walletAddress.slice(-4)}`);
      }
      if (chainId !== 10) {
        setMessage("Open MetaMask and switch to OP Mainnet…");
        await withWalletTimeout(
          switchChainAsync({ chainId: 10 }),
          "MetaMask did not switch networks. Open MetaMask, switch to OP Mainnet, then return and try again.",
        );
      }
      setMessage("Checking the exact amount and your OP USDC balance…");
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
      if (prepared.txHash) {
        await confirmPayment(prepared.txHash);
        return;
      }
      if (prepared.authorization) {
        setAuthorization(assertExpectedAuthorization(prepared.authorization, {
          from: checksummed,
          treasury: props.treasuryAddress,
          token: props.tokenAddress,
          amountMicros: props.invoice.amountMicros,
          chainId: 10,
        }));
        setMessage("Review the exact authorization below, then open MetaMask from the next button.");
        return;
      }
      await submitPayment();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Payment could not be prepared");
      setMessage(null);
    } finally {
      setBusy(false);
    }
  }, [address, chainId, confirmPayment, props.invoice, props.tokenAddress, props.treasuryAddress, props.walletAddress, submitPayment, switchChainAsync]);

  const authorizePayment = useCallback(async () => {
    if (!props.invoice || !address || !authorization) return;
    let signed = false;
    setBusy(true); setError(null);
    setMessage("Signature request sent. Open MetaMask if it did not appear automatically…");
    try {
      const checksummed = getAddress(address);
      const useMetaMaskConnect = shouldUseMetaMaskConnectForAuthorization(
        connector?.id,
        window.navigator.userAgent,
        Boolean((window.ethereum as { isMetaMask?: boolean } | undefined)?.isMetaMask),
      );
      const signature = await withWalletTimeout(
        useMetaMaskConnect
          ? signAuthorizationWithMetaMaskConnect(authorization, checksummed)
          : signTypedDataAsync({
              account: checksummed,
              ...relayAuthorizationRequest(authorization),
            }),
        "MetaMask did not respond. Open MetaMask and cancel any request still waiting there before trying again.",
      );
      signed = true;
      setAuthorization(null);
      await submitPayment(signature);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Payment authorization failed");
      setMessage(signed
        ? "Your authorization was saved. Do not authorize again; RegenHub will retry the gas-sponsored submission."
        : "The payment was not submitted. Review the authorization before trying again.");
    } finally {
      setBusy(false);
    }
  }, [address, authorization, connector?.id, props.invoice, signTypedDataAsync, submitPayment]);

  useEffect(() => {
    const invoice = props.invoice;
    if (!invoice?.txHash || !["submitted", "detected"].includes(invoice.status)) return;
    const controller = new AbortController();
    setPaymentDetected(invoice.status === "detected");
    setBusy(true);
    setMessage(invoice.status === "detected"
      ? "Payment received. RegenHub is completing safe OP confirmation…"
      : "Transaction submitted. RegenHub is checking OP confirmation…");
    void pollOnchainPayment({
      invoiceId: invoice.id,
      txHash: invoice.txHash as Hash,
      signal: controller.signal,
      onStatus: (status) => {
        if (status === "detected") {
          setPaymentDetected(true);
          setMessage("Payment received. RegenHub is completing safe OP confirmation…");
        }
      },
    }).then((paid) => {
      if (paid) {
        setMessage("Payment confirmed — membership is active.");
        setTimeout(() => window.location.reload(), 1_500);
      } else {
        setMessage("Payment is still awaiting OP safe confirmation. Do not pay again; reopen this page to resume checking.");
      }
    }).catch((cause) => {
      if (!controller.signal.aborted) {
        setError(`${cause instanceof Error ? cause.message : "Confirmation is delayed"}. Your transaction was submitted; do not pay again.`);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(false);
    });
    return () => controller.abort();
  }, [props.invoice]);

  useEffect(() => {
    if (!pendingAction || !isConnected || !address) return;
    const action = pendingAction;
    setPendingAction(null);
    setConnectModalSeen(false);
    void (action === "verify" ? connectAndVerify() : preparePayment());
  }, [address, connectAndVerify, isConnected, pendingAction, preparePayment]);

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
      void (action === "verify" ? connectAndVerify() : preparePayment());
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
          <Button disabled={busy || Boolean(submittedTxHash) || !props.configured || ["submitted", "detected"].includes(props.invoice.status)} onClick={() => authorization ? void authorizePayment() : begin("pay")} className="bg-sage/20 hover:bg-sage/40 text-sage border border-sage/30 text-xs gap-2">
            {busy && !paymentDetected && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {paymentDetected || props.invoice.status === "detected" ? "Payment received" : props.invoice.status === "submitted" ? "Confirming…" : authorization ? `Authorize $${(props.invoice.amountCents / 100).toFixed(2)} in MetaMask` : "Prepare payment"}
          </Button>
        </div>
      ) : props.invoice?.status === "paid" ? (
        <p className="text-xs text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Payment confirmed.</p>
      ) : (
        <p className="text-xs text-emerald-400">Wallet verified. Your next invoice appears here seven days before renewal.</p>
      )}
      {props.invoice && authorization && (
        <GaslessPaymentReview
          amountCents={props.invoice.amountCents}
          authorization={authorization}
        />
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
