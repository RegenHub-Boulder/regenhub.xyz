"use client";

import { useState } from "react";
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hash } from "viem";
import { Button } from "@/components/ui/button";
import { Loader2, Wallet } from "lucide-react";

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
};

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

function provider(): EthereumProvider | null {
  return (window as unknown as { ethereum?: EthereumProvider }).ethereum ?? null;
}

export function OnchainBillingCard(props: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connectAndVerify() {
    const wallet = provider();
    if (!wallet) {
      setError("Install or open MetaMask or Coinbase Wallet, then try again.");
      return;
    }
    setBusy(true); setError(null); setMessage(null);
    try {
      const accounts = await wallet.request({ method: "eth_requestAccounts" }) as string[];
      const address = getAddress(accounts[0]);
      const challengeRes = await fetch("/api/portal/onchain/wallet/challenge", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }),
      });
      const challenge = await challengeRes.json();
      if (!challengeRes.ok) throw new Error(challenge.error ?? "Could not create wallet challenge");
      const signature = await wallet.request({ method: "personal_sign", params: [challenge.message, address] });
      const verifyRes = await fetch("/api/portal/onchain/wallet/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_id: challenge.id, address, signature }),
      });
      const verified = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verified.error ?? "Wallet verification failed");
      setMessage(`Verified ${address.slice(0, 6)}…${address.slice(-4)}. Refreshing…`);
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet verification failed");
    } finally { setBusy(false); }
  }

  async function pay() {
    if (!props.invoice || !props.walletAddress) return;
    const wallet = provider();
    if (!wallet) { setError("Install or open MetaMask or Coinbase Wallet, then try again."); return; }
    setBusy(true); setError(null); setMessage(null);
    try {
      const accounts = await wallet.request({ method: "eth_requestAccounts" }) as string[];
      const address = getAddress(accounts[0]);
      if (address.toLowerCase() !== props.walletAddress.toLowerCase()) {
        throw new Error(`Connect the verified wallet ${props.walletAddress.slice(0, 8)}…${props.walletAddress.slice(-4)}`);
      }
      try {
        await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa" }] });
      } catch (cause) {
        const code = (cause as { code?: number }).code;
        if (code !== 4902) throw cause;
        await wallet.request({ method: "wallet_addEthereumChain", params: [{
          chainId: "0xa", chainName: "OP Mainnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://mainnet.optimism.io"], blockExplorerUrls: ["https://optimistic.etherscan.io"],
        }] });
      }
      const data = encodeFunctionData({
        abi: erc20Abi, functionName: "transfer",
        args: [props.treasuryAddress, BigInt(props.invoice.amountMicros)],
      });
      const txHash = await wallet.request({ method: "eth_sendTransaction", params: [{
        from: address, to: props.tokenAddress, data,
      }] }) as Hash;
      setMessage("Transaction submitted. RegenHub is checking OP confirmation…");
      const res = await fetch("/api/portal/onchain/submit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: props.invoice.id, tx_hash: txHash }),
      });
      const result = await res.json();
      if (!res.ok && res.status !== 202) throw new Error(result.error ?? "Could not track transaction");
      setMessage(result.status === "paid" ? "Payment confirmed — membership is active." : "Payment detected — confirmation will finish automatically.");
      setTimeout(() => window.location.reload(), 1500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Payment could not be submitted");
    } finally { setBusy(false); }
  }

  return (
    <div className="glass-panel border border-sage/20 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Wallet className="w-4 h-4 text-sage" />
        <p className="font-medium text-sm">Pay direct to the RegenHub treasury</p>
      </div>
      <p className="text-xs text-muted">Native USDC on OP Mainnet · same membership rate · your wallet always approves the transaction.</p>
      {!props.walletVerifiedBySignature ? (
        <Button disabled={busy} onClick={connectAndVerify} className="btn-glass text-xs gap-2">
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Connect & verify wallet
        </Button>
      ) : props.invoice && props.invoice.status !== "paid" ? (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm">
            <p className="font-medium">${(props.invoice.amountCents / 100).toFixed(2)} USDC</p>
            <p className="text-xs text-muted">Due {new Date(props.invoice.dueAt).toLocaleDateString()}</p>
          </div>
          <Button disabled={busy || !props.configured || ["submitted", "detected"].includes(props.invoice.status)} onClick={pay} className="bg-sage/20 hover:bg-sage/40 text-sage border border-sage/30 text-xs gap-2">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {["submitted", "detected"].includes(props.invoice.status) ? "Confirming…" : "Pay with crypto"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-emerald-400">Wallet verified. Your next invoice appears here seven days before renewal.</p>
      )}
      {props.walletAddress && <p className="text-[11px] text-muted font-mono break-all">Verified wallet: {props.walletAddress}</p>}
      {props.invoice?.txHash && <a className="text-xs text-sage underline" href={`https://optimistic.etherscan.io/tx/${props.invoice.txHash}`} target="_blank" rel="noreferrer">View transaction</a>}
      {message && <p className="text-xs text-emerald-400">{message}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
