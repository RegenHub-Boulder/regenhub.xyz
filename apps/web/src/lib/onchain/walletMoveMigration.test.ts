import type { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  addInvoice, addMember, addOnchainSubscription, addRelayJob, createOnchainDb, linkWallet,
  migration, one, rows, syntheticAddress,
} from "../../../test/onchainDb";

let pg: PGlite | null = null;
afterEach(async () => { await pg?.close(); pg = null; });

async function db() {
  pg = await createOnchainDb();
  return pg;
}

const move = (db: PGlite, memberId: number, address: string, fromWalletId: number) =>
  one(db, "select move_member_wallet($1, $2, $3) id", [memberId, address, fromWalletId]).then((r) => Number(r.id));
const unlink = (db: PGlite, memberId: number, walletId: number) =>
  one(db, "select unlink_member_wallet($1, $2) id", [memberId, walletId]).then((r) => Number(r.id));
const activeHolder = async (db: PGlite, address: string) =>
  (await rows(db, "select member_id from member_wallets where address_normalized = lower($1) and revoked_at is null", [address]))
    .map((r) => r.member_id);

describe("058_wallet_move.sql", () => {
  it("applies twice over production-shaped rows: revoked history, a 0xdead tombstone, a subscription on a revoked wallet", async () => {
    pg = await createOnchainDb({ stopBefore058: true });
    const test = await addMember(pg, "Test Account");
    const tomb = await addMember(pg, "Tombstoned");
    const used = syntheticAddress();
    const oldWallet = await linkWallet(pg, test, used);
    await pg.query(
      `insert into subscriptions(member_id, payment_rail, wallet_id, plan_key, monthly_cents, status)
       values ($1, 'onchain', $2, 'hub_friend', 10000, 'canceled')`, [test, oldWallet]);
    await linkWallet(pg, test, syntheticAddress()); // revokes `used`, keeps the row
    const tombWallet = await linkWallet(pg, tomb, syntheticAddress());
    await pg.query(
      `update member_wallets set address = '0xdEaD000000000000000000000000000000000001', revoked_at = now()
       where id = $1`, [tombWallet]);

    // Before 058 a revoked row still owns its address.
    const real = await addMember(pg, "Real Account");
    await expect(linkWallet(pg, real, used)).rejects.toThrow(/belongs to another member/);

    const sql = await migration("058_wallet_move.sql");
    await pg.exec(sql);
    await pg.exec(sql);

    expect(await rows(pg, `select conname from pg_constraint
      where conrelid = 'member_wallets'::regclass and contype = 'u'`)).toEqual([]);
    const relinked = await linkWallet(pg, real, used);
    expect(relinked).not.toBe(oldWallet);
    expect(await activeHolder(pg, used)).toEqual([real]);
    expect(Number((await one(pg, "select wallet_id from subscriptions where member_id = $1", [test])).wallet_id)).toBe(oldWallet);
    expect((await one(pg, "select address, revoked_at is not null revoked from member_wallets where id = $1", [tombWallet])))
      .toEqual({ address: "0xdEaD000000000000000000000000000000000001", revoked: true });
  }, 20_000);

  it("moves an idle wallet to the signing member, keeps the old row as history, and audits the move", async () => {
    const db_ = await db();
    const from = await addMember(db_, "Old Account");
    const to = await addMember(db_, "New Account");
    const address = syntheticAddress();
    const fromWallet = await linkWallet(db_, from, address);
    // The new account's previous wallet is replaced, like any re-link.
    const previous = await linkWallet(db_, to, syntheticAddress());

    const moved = await move(db_, to, address, fromWallet);

    expect(moved).not.toBe(fromWallet);
    expect(await activeHolder(db_, address)).toEqual([to]);
    expect(await rows(db_, "select id::int, member_id, revoked_at is not null revoked from member_wallets where id in ($1, $2, $3) order by id",
      [fromWallet, previous, moved])).toEqual([
      { id: fromWallet, member_id: from, revoked: true },
      { id: previous, member_id: to, revoked: true },
      { id: moved, member_id: to, revoked: false },
    ]);
    const audit = await rows(db_, "select actor_member_id, action, target_table, target_id, payload from admin_actions");
    expect(audit).toEqual([{
      actor_member_id: to,
      action: "wallet_moved",
      target_table: "member_wallets",
      target_id: String(moved),
      payload: {
        address: address.toLowerCase(),
        from_member_id: from,
        from_wallet_id: fromWallet,
        to_member_id: to,
        to_wallet_id: moved,
      },
    }]);
  });

  it.each(["active", "trialing", "past_due", "incomplete"])(
    "refuses to move a wallet whose account has a %s on-chain subscription", async (status) => {
      const db_ = await db();
      const from = await addMember(db_, "Paying Account");
      const to = await addMember(db_, "Other Account");
      const address = syntheticAddress();
      const wallet = await linkWallet(db_, from, address);
      await addOnchainSubscription(db_, from, wallet, status);

      await expect(move(db_, to, address, wallet)).rejects.toThrow("wallet in use: live_subscription");
      expect(await activeHolder(db_, address)).toEqual([from]);
      expect(await rows(db_, "select * from admin_actions")).toEqual([]);
    });

  it.each(["open", "submitted", "detected"])("refuses to move a wallet whose account has a %s invoice", async (status) => {
    const db_ = await db();
    const from = await addMember(db_, "Invoiced Account");
    const to = await addMember(db_, "Other Account");
    const address = syntheticAddress();
    const wallet = await linkWallet(db_, from, address);
    const sub = await addOnchainSubscription(db_, from, wallet, "active");
    await addInvoice(db_, sub, from, status);
    await db_.query("update subscriptions set status = 'canceled' where id = $1", [sub]);

    await expect(move(db_, to, address, wallet)).rejects.toThrow("wallet in use: open_invoice");
    expect(await activeHolder(db_, address)).toEqual([from]);
  });

  it.each(["signed", "submitting"])("refuses to move a wallet with a %s gasless relay job", async (status) => {
    const db_ = await db();
    const from = await addMember(db_, "Relaying Account");
    const to = await addMember(db_, "Other Account");
    const address = syntheticAddress();
    const wallet = await linkWallet(db_, from, address);
    const sub = await addOnchainSubscription(db_, from, wallet, "active");
    const invoice = await addInvoice(db_, sub, from, "open");
    await addRelayJob(db_, invoice, from, wallet, address, status);
    // Only the relay job is left: the invoice and subscription are already settled.
    await db_.query("update onchain_invoices set status = 'void' where id = $1", [invoice]);
    await db_.query("update subscriptions set status = 'canceled' where id = $1", [sub]);

    await expect(move(db_, to, address, wallet)).rejects.toThrow("wallet in use: relay_in_flight");
  });

  it("moves once the old account's membership is canceled and its invoices and relays are settled", async () => {
    const db_ = await db();
    const from = await addMember(db_, "Former Member");
    const to = await addMember(db_, "New Account");
    const address = syntheticAddress();
    const wallet = await linkWallet(db_, from, address);
    const sub = await addOnchainSubscription(db_, from, wallet, "active");
    const invoice = await addInvoice(db_, sub, from, "paid");
    await addRelayJob(db_, invoice, from, wallet, address, "submitted");
    await addRelayJob(db_, await addInvoice(db_, sub, from, "expired"), from, wallet, address, "expired");
    await addRelayJob(db_, await addInvoice(db_, sub, from, "void"), from, wallet, address, "prepared");
    await db_.query("update subscriptions set status = 'canceled' where id = $1", [sub]);

    await move(db_, to, address, wallet);
    expect(await activeHolder(db_, address)).toEqual([to]);
    // The canceled subscription keeps pointing at the (now revoked) history row.
    expect(Number((await one(db_, "select wallet_id from subscriptions where id = $1", [sub])).wallet_id)).toBe(wallet);
  });

  it("only one of two concurrent moves of the same wallet wins", async () => {
    const db_ = await db();
    const from = await addMember(db_, "Holder");
    const first = await addMember(db_, "First Mover");
    const second = await addMember(db_, "Second Mover");
    const address = syntheticAddress();
    const wallet = await linkWallet(db_, from, address);

    // Both challenges were issued while `from` held the wallet.
    const results = await Promise.allSettled([move(db_, first, address, wallet), move(db_, second, address, wallet)]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(loser.reason)).toMatch("wallet changed accounts");
    expect(await rows(db_, "select count(*)::int n from member_wallets where address_normalized = lower($1) and revoked_at is null", [address]))
      .toEqual([{ n: 1 }]);
    expect(await rows(db_, "select action from admin_actions")).toEqual([{ action: "wallet_moved" }]);
  });

  it("refuses a move into a disabled account", async () => {
    const db_ = await db();
    const from = await addMember(db_, "Holder");
    const disabled = await addMember(db_, "Disabled Account", { disabled: true });
    const address = syntheticAddress();
    const wallet = await linkWallet(db_, from, address);

    await expect(move(db_, disabled, address, wallet)).rejects.toThrow("member is disabled");
    expect(await activeHolder(db_, address)).toEqual([from]);
  });

  it("refuses a move whose challenge names a different wallet row", async () => {
    const db_ = await db();
    const from = await addMember(db_, "Holder");
    const to = await addMember(db_, "Mover");
    const wallet = await linkWallet(db_, from, syntheticAddress());
    await expect(move(db_, to, syntheticAddress(), wallet)).rejects.toThrow("wallet changed accounts");
  });

  it("removes an idle wallet, frees the address and audits it", async () => {
    const db_ = await db();
    const member = await addMember(db_, "Remover");
    const address = syntheticAddress();
    const wallet = await linkWallet(db_, member, address);

    expect(await unlink(db_, member, wallet)).toBe(wallet);

    expect(await activeHolder(db_, address)).toEqual([]);
    expect((await one(db_, "select revoked_at is not null revoked from member_wallets where id = $1", [wallet])).revoked).toBe(true);
    expect(await rows(db_, "select actor_member_id, action, target_id, payload from admin_actions")).toEqual([{
      actor_member_id: member, action: "wallet_removed", target_id: String(wallet),
      payload: { address: address.toLowerCase(), member_id: member, wallet_id: wallet },
    }]);
    const other = await addMember(db_, "Next Owner");
    await linkWallet(db_, other, address);
    expect(await activeHolder(db_, address)).toEqual([other]);
  });

  it("refuses to remove a wallet while the account has a live crypto membership", async () => {
    const db_ = await db();
    const member = await addMember(db_, "Paying Member");
    const wallet = await linkWallet(db_, member, syntheticAddress());
    await addOnchainSubscription(db_, member, wallet, "past_due");

    await expect(unlink(db_, member, wallet)).rejects.toThrow("wallet in use: live_subscription");
    expect((await one(db_, "select revoked_at from member_wallets where id = $1", [wallet])).revoked_at).toBeNull();
  });

  it("refuses to remove someone else's wallet, or one already removed", async () => {
    const db_ = await db();
    const owner = await addMember(db_, "Owner");
    const intruder = await addMember(db_, "Intruder");
    const wallet = await linkWallet(db_, owner, syntheticAddress());

    await expect(unlink(db_, intruder, wallet)).rejects.toThrow("wallet not found");
    expect((await one(db_, "select revoked_at from member_wallets where id = $1", [wallet])).revoked_at).toBeNull();
    await unlink(db_, owner, wallet);
    await expect(unlink(db_, owner, wallet)).rejects.toThrow("wallet not found");
  });

  it("refuses removal by a disabled member", async () => {
    const db_ = await db();
    const member = await addMember(db_, "Disabled Member");
    const wallet = await linkWallet(db_, member, syntheticAddress());
    await db_.query("update members set disabled = true where id = $1", [member]);
    await expect(unlink(db_, member, wallet)).rejects.toThrow("member is disabled");
  });

  it("re-links a previously revoked address: the same member reuses its row, another member gets a new one", async () => {
    const db_ = await db();
    const first = await addMember(db_, "First");
    const second = await addMember(db_, "Second");
    const address = syntheticAddress();
    const original = await linkWallet(db_, first, address);
    await unlink(db_, first, original);

    expect(await linkWallet(db_, first, address)).toBe(original);
    await unlink(db_, first, original);
    const secondRow = await linkWallet(db_, second, address);
    expect(secondRow).not.toBe(original);
    expect(await activeHolder(db_, address)).toEqual([second]);
    // Linking a wallet another account actively holds still needs the move.
    await expect(linkWallet(db_, first, address)).rejects.toThrow("wallet already belongs to another member");
  });

  it("a subscription or relay job can only point at an active wallet of its own member", async () => {
    const db_ = await db();
    const member = await addMember(db_, "Member");
    const other = await addMember(db_, "Other");
    const wallet = await linkWallet(db_, member, syntheticAddress());
    const othersWallet = await linkWallet(db_, other, syntheticAddress());

    await expect(addOnchainSubscription(db_, member, othersWallet)).rejects.toThrow("not an active wallet of this member");
    await unlink(db_, member, wallet);
    await expect(addOnchainSubscription(db_, member, wallet)).rejects.toThrow("not an active wallet of this member");
  });

  it.each(["open", "submitted", "detected", "exception"])(
    "refuses to move a wallet INTO an account whose own payment is %s, and leaves its payer alone", async (status) => {
      const db_ = await db();
      const from = await addMember(db_, "Idle Holder");
      const to = await addMember(db_, "Paying Receiver");
      const address = syntheticAddress();
      const fromWallet = await linkWallet(db_, from, address);
      const current = await linkWallet(db_, to, syntheticAddress());
      const sub = await addOnchainSubscription(db_, to, current, "active");
      await addInvoice(db_, sub, to, status);

      await expect(move(db_, to, address, fromWallet)).rejects.toThrow("current wallet in use: open_invoice");
      expect(await activeHolder(db_, address)).toEqual([from]);
      // The receiving account's payment still expects its own wallet as sender.
      expect(Number((await one(db_, "select wallet_id from subscriptions where id = $1", [sub])).wallet_id)).toBe(current);
      expect((await one(db_, "select revoked_at from member_wallets where id = $1", [current])).revoked_at).toBeNull();
      expect(await rows(db_, "select * from admin_actions")).toEqual([]);
    });

  it("refuses to move a wallet into an account with a gasless payment in flight", async () => {
    const db_ = await db();
    const from = await addMember(db_, "Idle Holder");
    const to = await addMember(db_, "Relaying Receiver");
    const address = syntheticAddress();
    const fromWallet = await linkWallet(db_, from, address);
    const currentAddress = syntheticAddress();
    const current = await linkWallet(db_, to, currentAddress);
    const sub = await addOnchainSubscription(db_, to, current, "active");
    const invoice = await addInvoice(db_, sub, to, "open");
    await addRelayJob(db_, invoice, to, current, currentAddress, "submitting");
    await db_.query("update onchain_invoices set status = 'void' where id = $1", [invoice]);

    await expect(move(db_, to, address, fromWallet)).rejects.toThrow("current wallet in use: relay_in_flight");
    expect(await activeHolder(db_, address)).toEqual([from]);
  });

  it("refuses to switch an account's wallet while it has an unsettled payment, but re-verifying the same wallet is fine", async () => {
    const db_ = await db();
    const member = await addMember(db_, "Payer");
    const address = syntheticAddress();
    const current = await linkWallet(db_, member, address);
    const sub = await addOnchainSubscription(db_, member, current, "active");
    await addInvoice(db_, sub, member, "submitted");

    await expect(linkWallet(db_, member, syntheticAddress())).rejects.toThrow("current wallet in use: open_invoice");
    expect(await linkWallet(db_, member, address)).toBe(current);
    expect(Number((await one(db_, "select wallet_id from subscriptions where id = $1", [sub])).wallet_id)).toBe(current);
  });

  it("moves into an account whose live membership is fully paid, and repoints that membership", async () => {
    const db_ = await db();
    const from = await addMember(db_, "Idle Holder");
    const to = await addMember(db_, "Paid-up Receiver");
    const address = syntheticAddress();
    const fromWallet = await linkWallet(db_, from, address);
    const current = await linkWallet(db_, to, syntheticAddress());
    const sub = await addOnchainSubscription(db_, to, current, "active");
    await addInvoice(db_, sub, to, "paid");

    const moved = await move(db_, to, address, fromWallet);
    expect(Number((await one(db_, "select wallet_id from subscriptions where id = $1", [sub])).wallet_id)).toBe(moved);
  });

  it("refuses to link a wallet to a disabled member", async () => {
    const db_ = await db();
    const disabled = await addMember(db_, "Disabled Member", { disabled: true });
    await expect(linkWallet(db_, disabled, syntheticAddress())).rejects.toThrow("member is disabled");
    await expect(one(db_, "select bind_member_wallet($1, $2, 'admin_prior_payment') id", [disabled, syntheticAddress()]))
      .rejects.toThrow("member is disabled");
  });

  it("refuses to remove a wallet while a failed payment could still be resubmitted", async () => {
    const db_ = await db();
    const member = await addMember(db_, "Exception Payer");
    const wallet = await linkWallet(db_, member, syntheticAddress());
    const sub = await addOnchainSubscription(db_, member, wallet, "active");
    await addInvoice(db_, sub, member, "exception");
    await db_.query("update subscriptions set status = 'canceled' where id = $1", [sub]);

    await expect(unlink(db_, member, wallet)).rejects.toThrow("wallet in use: open_invoice");
  });

  it("an invoice can't be created or made payable once its wallet has left the account", async () => {
    const db_ = await db();
    const member = await addMember(db_, "Former Payer");
    const wallet = await linkWallet(db_, member, syntheticAddress());
    const sub = await addOnchainSubscription(db_, member, wallet, "active");
    const failed = await addInvoice(db_, sub, member, "exception");
    await db_.query("update onchain_invoices set status = 'void' where id = $1", [failed]);
    await db_.query("update subscriptions set status = 'canceled' where id = $1", [sub]);
    await unlink(db_, member, wallet);

    // The renewal generator read the subscription before it was canceled.
    await expect(addInvoice(db_, sub, member, "open")).rejects.toThrow("not an active wallet of this member");
    // A voided, failed payment can't be revived either.
    await expect(db_.query("update onchain_invoices set status = 'submitted' where id = $1", [failed]))
      .rejects.toThrow("not an active wallet of this member");
    // History still settles: an invoice can still be closed or recorded as paid.
    await addInvoice(db_, sub, member, "expired");
    await db_.query("update onchain_invoices set status = 'expired', exception_reason = 'closed' where id = $1", [failed]);
  });

  it("a canceled subscription can't come back to life on a wallet that left, and its history still updates", async () => {
    const db_ = await db();
    const member = await addMember(db_, "Lapsed Member");
    const wallet = await linkWallet(db_, member, syntheticAddress());
    const sub = await addOnchainSubscription(db_, member, wallet, "active");
    await db_.query("update subscriptions set status = 'canceled' where id = $1", [sub]);
    await unlink(db_, member, wallet);

    for (const status of ["active", "trialing", "past_due", "incomplete"]) {
      await expect(db_.query("update subscriptions set status = $2 where id = $1", [sub, status]))
        .rejects.toThrow("not an active wallet of this member");
    }
    await db_.query("update subscriptions set cancel_at_period_end = true, status = 'canceled' where id = $1", [sub]);
  });

  it("a relay job can't go in flight from a wallet that left the account", async () => {
    const db_ = await db();
    const member = await addMember(db_, "Relay Member");
    const address = syntheticAddress();
    const wallet = await linkWallet(db_, member, address);
    const sub = await addOnchainSubscription(db_, member, wallet, "active");
    const invoice = await addInvoice(db_, sub, member, "open");
    await addRelayJob(db_, invoice, member, wallet, address, "prepared");
    await db_.query("update onchain_invoices set status = 'void' where id = $1", [invoice]);
    await db_.query("update subscriptions set status = 'canceled' where id = $1", [sub]);
    await unlink(db_, member, wallet);

    for (const status of ["signed", "submitting"]) {
      await expect(db_.query("update onchain_relay_jobs set status = $2 where invoice_id = $1", [invoice, status]))
        .rejects.toThrow("not an active wallet of this member");
    }
    await db_.query("update onchain_relay_jobs set status = 'expired' where invoice_id = $1", [invoice]);
  });

  it("keeps the wallet functions service-role only", async () => {
    const db_ = await db();
    await db_.exec("set role authenticated");
    for (const call of [
      "select move_member_wallet(1, '0x0000000000000000000000000000000000000001', 1)",
      "select unlink_member_wallet(1, 1)",
      "select wallet_release_blocker(1)",
    ]) {
      await expect(db_.exec(call)).rejects.toThrow(/permission denied/);
    }
    await db_.exec("reset role");
  });
});
