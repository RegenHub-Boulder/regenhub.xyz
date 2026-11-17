"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";

// The wallet stack is heavy: load it only once someone chooses USDC.
const CryptoPayment = dynamic(() => import("@/components/membership/CryptoPayment"), {
  ssr: false,
  loading: () => <Button disabled className="btn-glass w-full gap-2">Connecting wallet…</Button>,
});

/** "Pay with USDC" for one day pass: the same wallet flow as a crypto membership. */
export function CryptoPassButton({ amountCents }: { amountCents: number }) {
  const [opened, setOpened] = useState(false);
  if (opened) return <CryptoPayment dayPass={{ amountCents }} autoStart />;
  return (
    <Button type="button" onClick={() => setOpened(true)} className="btn-glass w-full gap-2">
      <Wallet className="w-4 h-4" />
      Pay with USDC
    </Button>
  );
}
