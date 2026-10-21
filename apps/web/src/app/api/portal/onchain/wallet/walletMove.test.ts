import type { PGlite } from "@electric-sql/pglite";
import { AsyncLocalStorage } from "node:async_hooks";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addInvoice, addOnchainSubscription, addRelayJob, createOnchainDb, one, rows,
} from "../../../../../../test/onchainDb";
import {
  pglitePostgrest, SESSION_COOKIE, sessionCookieValue, type FakeAuthUser,
} from "../../../../../../test/pglitePostgrest";

// The only fake: Next's per-request cookie jar. Everything behind it —
// session lookup, supabase-js, the SQL functions — is the real code against PGlite.
type Cookie = { name: string; value: string };
const jar = vi.hoisted(() => ({ cookies: [] as Cookie[], request: null as { getStore(): Cookie[] | undefined } | null }));
vi.mock("next/headers", () => ({
  cookies: async () => {
    const cookies = jar.request?.getStore() ?? [];
    return { getAll: () => cookies, set: () => undefined };
  },
}));
const requestCookies = new AsyncLocalStorage<Cookie[]>();
jar.request = requestCookies;

import { POST as challengePOST } from "./challenge/route";
import { POST as verifyPOST } from "./verify/route";
import { POST as removePOST } from "./remove/route";

let pg: PGlite;
const users = new Map<string, FakeAuthUser>();
let userSeed = 0;

beforeEach(async () => {
  pg = await createOnchainDb();
  users.clear();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://regenhub.test");
  vi.stubGlobal("fetch", pglitePostgrest(pg, users));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await pg.close();
});

type Account = { memberId: number; token: string; user: FakeAuthUser };

async function account(name: string, opts: { disabled?: boolean } = {}): Promise<Account> {
  userSeed += 1;
  const user = { id: `00000000-0000-4000-8000-${String(userSeed).padStart(12, "0")}`, email: `${name.toLowerCase()}@example.test` };
  const token = `token-${userSeed}`;
  users.set(token, user);
  const row = await one(pg,
    `insert into members(name, email, supabase_user_id, disabled, approved_for_daily, approved_for_full)
     values ($1, $2, $3, $4, true, true) returning id`, [name, user.email, user.id, opts.disabled ?? false]);
  return { memberId: row.id as number, token, user };
}

function signIn(who: Account) {
  jar.cookies = [{ name: SESSION_COOKIE, value: sessionCookieValue(who.token, who.user) }];
}

/** Call a route handler as whoever is signed in right now (the cookies are captured per request). */
const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
  requestCookies.run(jar.cookies, () => handler(new Request("http://localhost/api", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })));

async function challenge(who: Account, wallet: PrivateKeyAccount, move = false) {
  signIn(who);
  const res = await post(challengePOST, { address: wallet.address, ...(move ? { move: true } : {}) });
  return { status: res.status, body: await res.json() as { id: number; message: string; error?: string } };
}

async function verify(who: Account, wallet: PrivateKeyAccount, c: { id: number; message: string }, signer = wallet) {
  signIn(who);
  const res = await post(verifyPOST, {
    challenge_id: c.id, address: wallet.address, signature: await signer.signMessage({ message: c.message }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function link(who: Account, wallet: PrivateKeyAccount, move = false) {
  const c = await challenge(who, wallet, move);
  expect(c.status).toBe(200);
  return verify(who, wallet, c.body);
}

async function remove(who: Account, walletId: unknown) {
  signIn(who);
  const res = await post(removePOST, { wallet_id: walletId });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const holderOf = async (wallet: PrivateKeyAccount) =>
  (await rows(pg, "select member_id from member_wallets where address_normalized = lower($1) and revoked_at is null",
    [wallet.address])).map((r) => r.member_id);
const walletIdOf = async (wallet: PrivateKeyAccount) =>
  Number((await one(pg, "select id from member_wallets where address_normalized = lower($1) and revoked_at is null",
    [wallet.address])).id);

describe("moving a wallet between accounts", () => {
  it("offers the move, then moves the wallet on a fresh signature and audits it", async () => {
    const holder = await account("Holder");
    const mover = await account("Mover");
    const wallet = privateKeyToAccount(generatePrivateKey());
    expect((await link(holder, wallet)).status).toBe(200);
    const fromWalletId = await walletIdOf(wallet);

    const attempt = await link(mover, wallet);
    expect(attempt).toEqual({ status: 409, body: {
      code: "wallet_linked_elsewhere",
      error: "This wallet is linked to another account. Sign a message to move it here.",
    } });
    expect(await holderOf(wallet)).toEqual([holder.memberId]);

    const offer = await challenge(mover, wallet, true);
    expect(offer.body.message).toContain("moves this wallet to your RegenHub account");
    const moved = await verify(mover, wallet, offer.body);

    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ moved: true, address: wallet.address });
    expect(await holderOf(wallet)).toEqual([mover.memberId]);
    expect(await rows(pg, "select actor_member_id, action, payload->>'from_member_id' from_member from admin_actions"))
      .toEqual([{ actor_member_id: mover.memberId, action: "wallet_moved", from_member: String(holder.memberId) }]);
    expect((await one(pg, "select revoked_at is not null revoked from member_wallets where id = $1", [fromWalletId])).revoked).toBe(true);
  });

  it("doesn't reveal before a signature whether an address is linked elsewhere", async () => {
    const holder = await account("Holder");
    const asker = await account("Asker");
    const held = privateKeyToAccount(generatePrivateKey());
    const free = privateKeyToAccount(generatePrivateKey());
    await link(holder, held);

    const [forHeld, forFree] = [await challenge(asker, held, true), await challenge(asker, free, true)];
    const shape = (c: typeof forHeld) => ({
      status: c.status,
      keys: Object.keys(c.body).sort(),
      text: c.body.message.replace(/0x[0-9a-fA-F]{40}/, "ADDR").replace(/(Nonce|Issued At|Expiration Time): .*/g, "$1"),
    });
    expect(shape(forHeld)).toEqual(shape(forFree));

    // A move request for a wallet nobody holds simply links it.
    expect((await verify(asker, free, forFree.body)).status).toBe(200);
    expect(await holderOf(free)).toEqual([asker.memberId]);
    expect(await rows(pg, "select * from admin_actions")).toEqual([]);
  });

  it("rejects a signature from a different key, an expired challenge and a reused one", async () => {
    const holder = await account("Holder");
    const mover = await account("Mover");
    const wallet = privateKeyToAccount(generatePrivateKey());
    const impostor = privateKeyToAccount(generatePrivateKey());
    await link(holder, wallet);

    const offer = await challenge(mover, wallet, true);
    expect(await verify(mover, wallet, offer.body, impostor)).toEqual({ status: 400, body: { error: "Signature does not match wallet" } });

    await pg.query("update wallet_verification_challenges set expires_at = now() - interval '1 second' where id = $1", [offer.body.id]);
    expect((await verify(mover, wallet, offer.body)).status).toBe(409);

    const fresh = await challenge(mover, wallet, true);
    expect((await verify(mover, wallet, fresh.body)).status).toBe(200);
    expect((await verify(mover, wallet, fresh.body)).body).toEqual({ error: "Wallet challenge is expired or already used" });
    expect(await rows(pg, "select action from admin_actions")).toEqual([{ action: "wallet_moved" }]);
  });

  it.each([
    ["a live crypto membership", "live_subscription", "has a live crypto membership"],
    ["an unpaid crypto invoice", "open_invoice", "has an unpaid crypto invoice"],
    ["a crypto payment in flight", "relay_in_flight", "has a crypto payment in progress"],
  ])("refuses to move a wallet whose account has %s", async (_label, blocker, phrase) => {
    const holder = await account("Holder");
    const mover = await account("Mover");
    const wallet = privateKeyToAccount(generatePrivateKey());
    await link(holder, wallet);
    // The move was offered while the holder was idle; the guard still runs at signing time.
    const offer = await challenge(mover, wallet, true);
    const walletId = await walletIdOf(wallet);
    const sub = await addOnchainSubscription(pg, holder.memberId, walletId, "active");
    if (blocker !== "live_subscription") {
      const invoice = await addInvoice(pg, sub, holder.memberId, blocker === "open_invoice" ? "open" : "paid");
      if (blocker === "relay_in_flight") await addRelayJob(pg, invoice, holder.memberId, walletId, wallet.address, "signed");
      await pg.query("update subscriptions set status = 'canceled' where id = $1", [sub]);
    }

    const refused = await verify(mover, wallet, offer.body);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("wallet_in_use");
    expect(refused.body.error).toContain(phrase);
    expect(refused.body.error).toMatch(/or ask an admin\.$/);
    expect(await holderOf(wallet)).toEqual([holder.memberId]);

    // The plain link attempt says so up front instead of offering a move that would fail.
    const attempt = await link(mover, wallet);
    expect(attempt.body.code).toBe("wallet_in_use");
    expect(await rows(pg, "select * from admin_actions")).toEqual([]);
  });

  it("lets only one of two concurrent moves of the same wallet win", async () => {
    const holder = await account("Holder");
    const first = await account("First");
    const second = await account("Second");
    const wallet = privateKeyToAccount(generatePrivateKey());
    await link(holder, wallet);
    const offers = [await challenge(first, wallet, true), await challenge(second, wallet, true)];
    const signatures = await Promise.all(offers.map((o) => wallet.signMessage({ message: o.body.message })));

    // Each request carries its own session; run both route handlers at once.
    const results = await Promise.all([first, second].map(async (who, i) => {
      signIn(who);
      const res = await post(verifyPOST, { challenge_id: offers[i].body.id, address: wallet.address, signature: signatures[i] });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    }));

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe("wallet_changed");
    expect(await rows(pg, "select count(*)::int n from admin_actions where action = 'wallet_moved'")).toEqual([{ n: 1 }]);
  });

  it("refuses a disabled member at every step", async () => {
    const holder = await account("Holder");
    const mover = await account("Mover");
    const wallet = privateKeyToAccount(generatePrivateKey());
    await link(holder, wallet);
    const offer = await challenge(mover, wallet, true);
    await pg.query("update members set disabled = true where id = $1", [mover.memberId]);

    expect((await verify(mover, wallet, offer.body)).status).toBe(401);
    expect((await challenge(mover, wallet, true)).status).toBe(401);
    expect(await holderOf(wallet)).toEqual([holder.memberId]);

    await pg.query("update members set disabled = true where id = $1", [holder.memberId]);
    expect((await remove(holder, await walletIdOf(wallet))).status).toBe(401);
  });
});

describe("removing a wallet", () => {
  it("removes an idle wallet, audits it, and frees the address for another account", async () => {
    const owner = await account("Owner");
    const next = await account("Next");
    const wallet = privateKeyToAccount(generatePrivateKey());
    await link(owner, wallet);
    const walletId = await walletIdOf(wallet);

    expect(await remove(owner, walletId)).toEqual({ status: 200, body: { wallet_id: walletId, removed: true } });
    expect(await holderOf(wallet)).toEqual([]);
    expect(await rows(pg, "select actor_member_id, action from admin_actions"))
      .toEqual([{ actor_member_id: owner.memberId, action: "wallet_removed" }]);

    // Re-linking the previously revoked address needs no move.
    expect((await link(next, wallet)).status).toBe(200);
    expect(await holderOf(wallet)).toEqual([next.memberId]);
  });

  it("refuses while the account has a live crypto membership", async () => {
    const owner = await account("Owner");
    const wallet = privateKeyToAccount(generatePrivateKey());
    await link(owner, wallet);
    const walletId = await walletIdOf(wallet);
    await addOnchainSubscription(pg, owner.memberId, walletId, "trialing");

    expect(await remove(owner, walletId)).toEqual({ status: 409, body: {
      code: "wallet_in_use",
      error: "This wallet pays for your live crypto membership. Cancel that membership first, or ask an admin.",
    } });
    expect(await holderOf(wallet)).toEqual([owner.memberId]);
  });

  it("refuses to remove someone else's wallet", async () => {
    const owner = await account("Owner");
    const intruder = await account("Intruder");
    const wallet = privateKeyToAccount(generatePrivateKey());
    await link(owner, wallet);

    expect(await remove(intruder, await walletIdOf(wallet))).toEqual({ status: 404, body: { error: "That wallet isn't linked to your account." } });
    expect(await holderOf(wallet)).toEqual([owner.memberId]);
    expect(await rows(pg, "select * from admin_actions")).toEqual([]);
  });

  it("rejects a request without a wallet id, and one with no session", async () => {
    const owner = await account("Owner");
    expect((await remove(owner, "1; drop table members")).status).toBe(400);
    jar.cookies = [];
    expect((await post(removePOST, { wallet_id: 1 })).status).toBe(401);
  });
});
