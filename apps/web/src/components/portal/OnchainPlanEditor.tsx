"use client";
import { useState } from "react";
import { getAllPlansSorted } from "@/lib/plans";

export function OnchainPlanEditor({ memberId }: { memberId?: number }) {
  const [plan, setPlan] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(removeDiscount = false) {
    setBusy(true);
    try {
      const response = await fetch(memberId ? `/api/admin/members/${memberId}/onchain-subscription` : "/api/portal/change-plan", {
        method: memberId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(plan ? { plan_key: plan } : {}), ...(memberId && (code || removeDiscount) ? { discount_code: removeDiscount ? "" : code } : {}) }),
      });
      const data = await response.json();
      setMessage(response.ok ? data.message : data.error);
    } catch { setMessage("Could not save changes. Please try again."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2 rounded border border-sage/20 p-3 text-sm">
    <p className="font-medium">Change crypto membership</p>
    <label className="block">Plan for next invoice<select aria-label="Plan for next invoice" className="block w-full rounded bg-neutral-900 p-2" value={plan} onChange={event => setPlan(event.target.value)}>
      <option value="">Keep current plan</option>
      {getAllPlansSorted().map(({ key, def }) => <option value={key} key={key}>{def.label} · ${def.defaultMonthlyCents / 100}/mo</option>)}
    </select></label>
    {memberId && <label className="block">Discount code<input aria-label="Subscription discount code" className="block w-full rounded border border-white/20 bg-transparent p-2" value={code} onChange={event => setCode(event.target.value)} /></label>}
    <p className="text-xs text-muted">Applies to the next invoice issued. Existing invoices keep their price. Access changes when the new invoice is paid.</p>
    <button type="button" className="btn-glass rounded px-3 py-2" disabled={busy || (!plan && !code)} onClick={() => save()}>{busy ? "Saving…" : "Save changes"}</button>
    {memberId && <button type="button" className="btn-glass rounded px-3 py-2" disabled={busy} onClick={() => { setCode(""); void save(true); }}>Remove discount</button>}
    {message && <p role="status" className="text-xs">{message}</p>}
  </div>;
}
