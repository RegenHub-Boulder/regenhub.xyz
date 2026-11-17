import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { makePgDb, type PgDb } from "../../../test/pgDb";

// "Pay with USDC" for a day pass is offered to everyone the card button is
// offered to. The browser always links the wallet first (challenge → sign →
// verify), so that link must work for a card member and for a person with no
// subscription or approval, while it still opens no crypto membership for them.
// Real Postgres with every migration (test/pgDb.ts), real routes; fakes: the
// OP chain receipt, email, Stripe config.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/email")>(),
  sendEmail: vi.fn(async () => true),
}));
vi.mock("@/lib/onchain/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/onchain/config")>(),
  getOpPublicClient: vi.fn(),
  assertOpPublicClient: vi.fn(async () => {}),
  isOnchainBillingConfigured: () => true,
  isGaslessRelayConfigured: () => true,
}));
vi.mock("@/lib/onchain/portalMember", () => ({
  requirePortalMember: async () => ({ user: { id: "member-uid" }, member: { id: 7, name: "Pat Example", email: "pat@example.test", disabled: false } }),
}));

import { createServiceClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getOpPublicClient, NATIVE_USDC_ADDRESS, TREASURY_ADDRESS } from "@/lib/onchain/config";
import { POST as challengePOST } from "@/app/api/portal/onchain/wallet/challenge/route";
import { POST as verifyPOST } from "@/app/api/portal/onchain/wallet/verify/route";
import { POST as startPurchase } from "@/app/api/portal/buy-passes/onchain/route";
import { POST as submitPayment } from "@/app/api/portal/onchain/submit/route";
import { POST as startMembership } from "@/app/api/membership/onchain/route";

const TX = `0x${"e".repeat(64)}`;
let db: PgDb;

const post = async (handler: (r: Request) => Promise<Response>, body: unknown) => {
  const res = await handler(new Request("http://localhost/api", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> & { error?: string } };
};

/** The browser's wallet link (lib/onchain/walletLink.ts), with a real key signing the challenge. */
async function linkWallet(wallet: PrivateKeyAccount, intent?: "membership" | "day_pass") {
  const challenge = await post(challengePOST, { address: wallet.address, ...(intent ? { intent } : {}) });
  if (challenge.status !== 200) return challenge;
  return post(verifyPOST, {
    challenge_id: challenge.body.id,
    address: wallet.address,
    signature: await wallet.signMessage({ message: challenge.body.message as string }),
  });
}

function chainPays(amountMicros: bigint, from: `0x${string}`) {
  const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  vi.mocked(getOpPublicClient).mockReturnValue({
    getTransactionReceipt: async () => ({
      status: "success", blockNumber: 1n, blockHash: `0x${"b".repeat(64)}`,
      logs: [{
        address: NATIVE_USDC_ADDRESS, logIndex: 0, data: encodeAbiParameters([{ type: "uint256" }], [amountMicros]),
        topics: encodeEventTopics({ abi: [transfer], eventName: "Transfer", args: { from, to: TREASURY_ADDRESS } }),
      }],
    }),
    getBlock: async () => ({ number: 0n, hash: `0x${"c".repeat(64)}`, timestamp: 0n }),
  } as never);
}

async function asWriter(statements: string) {
  const token = "00000000-0000-4000-8000-000005eed000";
  await db.exec(`select acquire_lock_writer('${token}');
    select set_config('request.headers', '{"x-lock-writer-token":"${token}"}', false);
    ${statements}
    select set_config('request.headers', '{}', false);
    select release_lock_writer('${token}');`);
}

/** Link → buy → pay → credited, as the "Pay with USDC" button runs it. */
async function buyPassWithUsdc(expectedCents: number) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const linked = await linkWallet(wallet, "day_pass");
  expect(linked.status, linked.body.error).toBe(200);

  const purchase = await post(startPurchase, {});
  expect(purchase.status, purchase.body.error).toBe(200);
  const invoice = purchase.body.invoice as { id: number; amount_cents: number; amount_usdc_micros: number };
  expect(invoice.amount_cents).toBe(expectedCents);

  chainPays(BigInt(invoice.amount_usdc_micros), wallet.address);
  const paid = await post(submitPayment, { invoice_id: invoice.id, tx_hash: TX });
  expect(paid.body).toMatchObject({ status: "paid", wasNew: true });
  const [row] = await db.sql("select day_passes_balance from members where id = 7");
  expect(Number(row.day_passes_balance)).toBe(1);
  return wallet;
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = await makePgDb();
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  vi.mocked(createClient).mockResolvedValue({
    ...db,
    auth: { getUser: async () => ({ data: { user: { id: "00000000-0000-4000-8000-000000000007" } } }) },
  } as never);
  await db.sql("insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000007', 'pat@example.test')");
  // Not approved for any membership: the card pass route doesn't ask, so neither does USDC.
  await asWriter(`insert into members (id, name, email, member_type, supabase_user_id)
    values (7, 'Pat Example', 'pat@example.test', 'day_pass', '00000000-0000-4000-8000-000000000007');`);
});

describe("buying a day pass with USDC needs no crypto membership", () => {
  it("a card member links a wallet, buys at the member rate, and still can't open a crypto membership", async () => {
    await db.sql(`update members set approved_for_daily = true, approved_for_full = true where id = 7`);
    await db.sql(`insert into subscriptions (id, member_id, payment_rail, stripe_subscription_id, stripe_customer_id, stripe_price_id,
        plan_key, monthly_cents, net_cents, status, current_period_end)
      values (50, 7, 'stripe', 'sub_test_50', 'cus_test_7', 'price_test', 'hot_desk', 25000, 25000, 'active', now() + interval '20 days')`);

    await buyPassWithUsdc(2500);

    // The membership gates stay where they were: the wallet link for a membership…
    const other = privateKeyToAccount(generatePrivateKey());
    expect(await linkWallet(other, "membership")).toMatchObject({ status: 409, body: { error: "A card membership is already active" } });
    expect(await linkWallet(other)).toMatchObject({ status: 409 });
    // …and the crypto membership route itself, even with a verified wallet on file.
    expect(await post(startMembership, { plan_key: "hot_desk" })).toMatchObject({ status: 409, body: { error: "You already have a live membership." } });
    expect(await db.sql("select id from subscriptions where payment_rail = 'onchain'")).toEqual([]);
  });

  it("a person with no subscription and no approval links a wallet and buys at the public rate", async () => {
    await buyPassWithUsdc(3000);

    const other = privateKeyToAccount(generatePrivateKey());
    expect(await linkWallet(other, "membership")).toMatchObject({ status: 403, body: { error: "Membership has not been approved yet" } });
    expect(await post(startMembership, { plan_key: "member_basic" })).toMatchObject({ status: 403 });
    expect(await db.sql("select id from subscriptions")).toEqual([]);
  });
});
