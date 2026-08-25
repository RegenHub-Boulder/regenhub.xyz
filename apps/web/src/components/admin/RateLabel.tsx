import { effectiveMonthlyCents } from "@/lib/stripeNet";

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** Net first; list struck through when they differ. */
export function RateLabel({
  monthly_cents,
  net_cents,
  suffix = "/mo",
  className = "",
}: {
  monthly_cents: number;
  net_cents?: number | null;
  suffix?: string;
  className?: string;
}) {
  const net = effectiveMonthlyCents({ monthly_cents, net_cents });
  const discounted = net_cents != null && net !== monthly_cents;
  return (
    <span className={className}>
      <span className="font-medium">{fmtMoney(net)}{suffix}</span>
      {discounted && (
        <span className="text-xs text-muted line-through ml-1.5 font-normal">
          {fmtMoney(monthly_cents)}
        </span>
      )}
    </span>
  );
}
