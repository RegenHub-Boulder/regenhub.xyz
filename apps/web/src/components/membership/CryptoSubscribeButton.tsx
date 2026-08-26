"use client";

import { useState } from "react";
import { getAddress } from "viem";
import { Button } from "@/components/ui/button";
import { Loader2, Wallet } from "lucide-react";

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
};

type Props = {
  planKey: string;
  className?: string;
};

function provider(): EthereumProvider | null {
  return (window as unknown as { ethereum?: EthereumProvider }).ethereum ?? null;
}

export function CryptoSubscribeButton({ planKey, className }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    const wallet = provider();
    if (!wallet) {
      setError("Install or open MetaMask or Coinbase Wallet, then try again.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const accounts = await wallet.request({ method: "eth_requestAccounts" }) as string[];
      if (!accounts[0]) throw new Error("No wallet account was selected.");
      const address = getAddress(accounts[0]);

      const challengeRes = await fetch("/api/portal/onchain/wallet/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const challenge = await challengeRes.json();
      if (!challengeRes.ok) throw new Error(challenge.error ?? "Could not create wallet challenge");

      const signature = await wallet.request({
        method: "personal_sign",
        params: [challenge.message, address],
      });
      const verifyRes = await fetch("/api/portal/onchain/wallet/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_id: challenge.id, address, signature }),
      });
      const verified = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verified.error ?? "Wallet verification failed");

      const setupRes = await fetch("/api/membership/onchain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_key: planKey }),
      });
      const setup = await setupRes.json();
      if (!setupRes.ok) throw new Error(setup.error ?? "Could not start crypto membership");
      window.location.href = "/portal?onchain=ready";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start crypto membership");
      setBusy(false);
    }
  }

  return (
    <div>
      <Button
        type="button"
        onClick={start}
        disabled={busy}
        className={className ?? "btn-glass w-full gap-2"}
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
        {busy ? "Connecting wallet…" : "Pay with crypto"}
      </Button>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
