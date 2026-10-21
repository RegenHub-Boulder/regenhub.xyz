"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";

const CryptoPayment = dynamic(() => import("./CryptoPayment"), {
  ssr: false,
  loading: () => <Button disabled className="btn-glass w-full gap-2">Connecting wallet…</Button>,
});

export function CryptoSubscribeButton(props: { planKey: string; className?: string }) {
  const [discountCode, setDiscountCode] = useState("");
  const [opened, setOpened] = useState(false);
  if (opened) return <CryptoPayment {...props} discountCode={discountCode} autoStart />;
  return (
    <div className="space-y-2"><label className="block text-xs">Discount code (optional)<input aria-label="Crypto discount code" className="w-full rounded border border-white/20 bg-transparent p-2" value={discountCode} onChange={event => setDiscountCode(event.target.value)} /></label>
    <Button type="button" onClick={() => setOpened(true)} className={props.className ?? "btn-glass w-full gap-2"}>
      <Wallet className="w-4 h-4" />
      Pay with crypto
    </Button></div>
  );
}
