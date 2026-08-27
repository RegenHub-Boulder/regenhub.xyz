import type { RelayAuthorization } from "@/lib/onchain/walletAuthorization";
import { authorizationExpiresAt } from "@/lib/onchain/walletAuthorization";

type Props = {
  amountCents: number;
  authorization: RelayAuthorization;
};

function shortAddress(address: string) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export function GaslessPaymentReview({ amountCents, authorization }: Props) {
  return (
    <div className="rounded-lg border border-sage/30 bg-sage/5 p-3 text-left space-y-2">
      <p className="text-xs font-medium">Review the exact wallet authorization</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted">Amount</dt>
        <dd>${(amountCents / 100).toFixed(2)} native USDC on OP Mainnet</dd>
        <dt className="text-muted">Recipient</dt>
        <dd>RegenHub Treasury Safe · {shortAddress(authorization.message.to)}</dd>
        <dt className="text-muted">Expires</dt>
        <dd>{authorizationExpiresAt(authorization).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</dd>
      </dl>
      <p className="text-[11px] text-muted">
        This is a single-use authorization for this exact amount. It is not an unlimited allowance and does not authorize future renewals.
      </p>
      <p className="text-[11px] text-amber-300">
        If MetaMask labels the request deceptive or untrusted, cancel it and tell RegenHub. Do not confirm a wallet security warning.
      </p>
    </div>
  );
}
