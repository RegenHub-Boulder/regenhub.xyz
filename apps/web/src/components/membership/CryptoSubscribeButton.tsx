"use client";

import { useState } from "react";
import { getAddress } from "viem";
import { Button } from "@/components/ui/button";
import { Loader2, Wallet } from "lucide-react";
import {
  discoverInjectedWallets,
  rememberInjectedWallet,
  rememberedInjectedWallet,
  type InjectedWallet,
} from "@/lib/onchain/injectedWallet";

type Props = {
  planKey: string;
  className?: string;
};

export function CryptoSubscribeButton({ planKey, className }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletOptions, setWalletOptions] = useState<InjectedWallet[]>([]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const wallets = await discoverInjectedWallets();
      if (wallets.length === 0) throw new Error("Install or open MetaMask, Coinbase Wallet, or another browser wallet, then try again.");
      const remembered = rememberedInjectedWallet(wallets);
      if (remembered || wallets.length === 1) {
        await startWithWallet(remembered ?? wallets[0]);
        return;
      }
      setWalletOptions(wallets);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not find a browser wallet");
    } finally {
      setBusy(false);
    }
  }

  async function startWithWallet(selected: InjectedWallet) {
    setBusy(true);
    setError(null);
    setWalletOptions([]);
    rememberInjectedWallet(selected);
    try {
      const accounts = await selected.provider.request({ method: "eth_requestAccounts" }) as string[];
      if (!accounts[0]) throw new Error("No wallet account was selected.");
      const address = getAddress(accounts[0]);

      const challengeRes = await fetch("/api/portal/onchain/wallet/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const challenge = await challengeRes.json();
      if (!challengeRes.ok) throw new Error(challenge.error ?? "Could not create wallet challenge");

      const signature = await selected.provider.request({
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
    } finally {
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
      {walletOptions.length > 1 && (
        <div className="mt-2 rounded-lg border border-white/10 bg-black/10 p-2 space-y-1.5">
          <p className="text-xs text-muted px-1">Choose the wallet you want to use:</p>
          {walletOptions.map((wallet) => (
            <Button
              key={wallet.id}
              type="button"
              disabled={busy}
              onClick={() => startWithWallet(wallet)}
              className="btn-glass w-full justify-start text-xs"
            >
              <Wallet className="w-3.5 h-3.5" /> {wallet.name}
            </Button>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
