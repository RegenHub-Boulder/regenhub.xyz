"use client";
// Mounted temporarily by walkthrough.py; never part of a deployable app route.
import { useState } from "react";
import { OnchainPlanEditor } from "@/components/portal/OnchainPlanEditor";
type Invoice = { id: number; plan_key: string; base_amount_cents: number; amount_cents: number; coupon_code: string | null; coupon_discount_cents: number };
export default function Fixture() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  async function issue() {
    const response = await fetch("/api/t241-fixture", { method: "POST" });
    setInvoices((await response.json()).invoices);
  }
  return <main className="mx-auto max-w-4xl p-10 space-y-6">
    <p className="text-sage">T241 · Local fixture · synthetic data only</p>
    <h1 className="text-3xl">Admin billing · Taylor Example</h1>
    <p>taylor@example.invalid · Crypto membership · Cold Desk $500/month</p>
    <OnchainPlanEditor memberId={7} />
    <button className="btn-glass px-4 py-2 rounded" onClick={issue}>Issue next test invoice</button>
    <h2 className="text-xl">Issued invoices · frozen prices</h2>
    <table className="w-full text-sm"><thead><tr>{["Invoice", "Plan", "Base", "Code", "Code off", "USDC due"].map(x => <th className="p-2 text-left" key={x}>{x}</th>)}</tr></thead>
      <tbody>{invoices.map(x => <tr className="border-t border-white/10" key={x.id}><td className="p-2">#{x.id}</td><td>{x.plan_key}</td><td>${x.base_amount_cents / 100}</td><td>{x.coupon_code ?? "—"}</td><td>${x.coupon_discount_cents / 100}</td><td>${(x.amount_cents / 100).toFixed(2)}</td></tr>)}</tbody></table>
    <p className="text-muted">This recording uses the real plan editor and migration pricing against an in-memory PostgreSQL fixture. No live payments or door operations.</p>
  </main>;
}
