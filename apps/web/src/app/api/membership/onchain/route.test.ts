import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/onchain/portalMember", () => ({ requirePortalMember: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/auditLog", () => ({
  AuditAction: { ONCHAIN_SUBSCRIPTION_CREATED: "onchain_subscription_created" },
  logAction: vi.fn(async () => undefined),
}));

import { POST } from "./route";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { createServiceClient } from "@/lib/supabase/admin";

function builder(args: {
  selectData?: unknown;
  insertData?: unknown;
  onInsert?: (value: unknown) => void;
}) {
  let inserted = false;
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "in", "limit", "is", "delete"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.insert = vi.fn((value: unknown) => {
    inserted = true;
    args.onInsert?.(value);
    return chain;
  });
  chain.single = vi.fn(async () => ({
    data: inserted ? args.insertData ?? null : args.selectData ?? null,
    error: null,
  }));
  chain.maybeSingle = vi.fn(async () => ({ data: args.selectData ?? null, error: null }));
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePortalMember).mockResolvedValue({
    user: { id: "auth-1", email: "member@example.org" },
    member: { id: 7, name: "Member", email: "member@example.org", disabled: false },
  } as never);
});

describe("POST /api/membership/onchain", () => {
  it("creates an incomplete subscription and payable first invoice without granting access", async () => {
    let subscriptionInsert: Record<string, unknown> | null = null;
    let invoiceInsert: Record<string, unknown> | null = null;
    const tables = {
      members: builder({ selectData: { id: 7, approved_for_daily: true, approved_for_full: true } }),
      subscriptions: builder({
        selectData: null,
        insertData: { id: 91 },
        onInsert: (value) => { subscriptionInsert = value as Record<string, unknown>; },
      }),
      member_wallets: builder({ selectData: { id: 12, address: "0x0000000000000000000000000000000000000001" } }),
      onchain_invoices: builder({
        insertData: { id: 101, amount_cents: 25_000, amount_usdc_micros: 250_000_000, due_at: "now", status: "open" },
        onInsert: (value) => { invoiceInsert = value as Record<string, unknown>; },
      }),
    };
    const from = vi.fn((table: keyof typeof tables) => tables[table]);
    vi.mocked(createServiceClient).mockReturnValue({ from } as never);

    const response = await POST(new Request("http://localhost/api/membership/onchain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_key: "hot_desk" }),
    }));

    expect(response.status).toBe(200);
    expect(subscriptionInsert).toMatchObject({
      member_id: 7,
      payment_rail: "onchain",
      wallet_id: 12,
      plan_key: "hot_desk",
      monthly_cents: 25_000,
      net_cents: 25_000,
      status: "incomplete",
    });
    expect(invoiceInsert).toMatchObject({
      subscription_id: 91,
      member_id: 7,
      amount_cents: 25_000,
      amount_usdc_micros: 250_000_000,
      chain_id: 10,
      status: "open",
    });
    const insertedInvoice = invoiceInsert as Record<string, unknown> | null;
    expect(new Date(String(insertedInvoice?.due_at)).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(from).not.toHaveBeenCalledWith("applications");
    await expect(response.json()).resolves.toMatchObject({
      subscription_id: 91,
      payment: {
        chain_id: 10,
        token_address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        treasury_address: "0xA594263e0449A28eAEf5BA6420E81cC1996b7782",
      },
    });
  });

  it("resumes the same incomplete setup after an interrupted wallet flow", async () => {
    const members = builder({ selectData: { id: 7, approved_for_daily: true, approved_for_full: true } });
    const subscriptions = builder({ selectData: { id: 91, payment_rail: "onchain", plan_key: "hot_desk", status: "incomplete" } });
    const wallets = builder({ selectData: { id: 12, address: "0x0000000000000000000000000000000000000001" } });
    const invoices = builder({ selectData: { id: 101, amount_cents: 25_000, amount_usdc_micros: 250_000_000, due_at: "later", status: "open" } });
    const from = vi.fn((table: string) => table === "members" ? members : table === "subscriptions" ? subscriptions : table === "member_wallets" ? wallets : invoices);
    vi.mocked(createServiceClient).mockReturnValue({ from } as never);

    const response = await POST(new Request("http://localhost/api/membership/onchain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_key: "hot_desk" }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      subscription_id: 91,
      invoice: { id: 101, status: "open" },
    });
    expect(subscriptions.insert).not.toHaveBeenCalled();
    expect(invoices.insert).not.toHaveBeenCalled();
  });

  it("does not create a crypto membership beside an existing card membership", async () => {
    const members = builder({ selectData: { id: 7, approved_for_daily: true, approved_for_full: true } });
    const subscriptions = builder({ selectData: { id: 44, payment_rail: "stripe", plan_key: "hot_desk", status: "active" } });
    const from = vi.fn((table: string) => table === "members" ? members : subscriptions);
    vi.mocked(createServiceClient).mockReturnValue({ from } as never);

    const response = await POST(new Request("http://localhost/api/membership/onchain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_key: "hot_desk" }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "You already have a live membership." });
    expect(from).not.toHaveBeenCalledWith("member_wallets");
  });

  it("requires signature verification before creating the subscription", async () => {
    const members = builder({ selectData: { id: 7, approved_for_daily: true, approved_for_full: true } });
    const subscriptions = builder({ selectData: null });
    const wallets = builder({ selectData: null });
    const from = vi.fn((table: string) => table === "members" ? members : table === "subscriptions" ? subscriptions : wallets);
    vi.mocked(createServiceClient).mockReturnValue({ from } as never);

    const response = await POST(new Request("http://localhost/api/membership/onchain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_key: "hot_desk" }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Connect and verify a wallet first." });
    expect(from).not.toHaveBeenCalledWith("onchain_invoices");
  });
});
