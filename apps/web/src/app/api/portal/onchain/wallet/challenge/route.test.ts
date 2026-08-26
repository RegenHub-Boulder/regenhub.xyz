import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/onchain/portalMember", () => ({ requirePortalMember: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/onchain/walletChallenge", () => ({
  createWalletChallenge: vi.fn(() => ({
    nonceHash: "hash",
    message: "Sign this RegenHub challenge",
    expiresAt: new Date("2026-08-27T00:00:00.000Z"),
  })),
}));

import { POST } from "./route";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { createServiceClient } from "@/lib/supabase/admin";

function chain(data: unknown) {
  const value: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "in", "limit", "insert"]) {
    value[method] = vi.fn(() => value);
  }
  value.maybeSingle = vi.fn(async () => ({ data, error: null }));
  value.single = vi.fn(async () => ({ data, error: null }));
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePortalMember).mockResolvedValue({
    user: { id: "auth-1" },
    member: { id: 7, name: "Member", email: "member@example.org", disabled: false },
  } as never);
});

describe("POST /api/portal/onchain/wallet/challenge", () => {
  it("allows an approved member to verify a wallet before the on-chain subscription exists", async () => {
    const subscriptions = chain(null);
    const members = chain({ approved_for_daily: true, approved_for_full: false });
    const challenges = chain({ id: 3, message: "Sign this RegenHub challenge", expires_at: "2026-08-27T00:00:00.000Z" });
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn((table: string) => table === "subscriptions" ? subscriptions : table === "members" ? members : challenges),
    } as never);

    const response = await POST(new Request("http://localhost/api/portal/onchain/wallet/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "0x0000000000000000000000000000000000000001" }),
    }));

    expect(response.status).toBe(200);
    expect(challenges.insert).toHaveBeenCalled();
  });
});
