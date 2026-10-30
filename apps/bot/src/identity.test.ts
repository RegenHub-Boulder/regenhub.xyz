import { test } from "node:test";
import assert from "node:assert/strict";
import { decideIdentity } from "./identity.js";

test("unbound row binds on first interaction", () => {
  assert.deepEqual(decideIdentity({ telegram_user_id: null }, 42), { action: "bind" });
  assert.deepEqual(decideIdentity({ telegram_user_id: undefined }, 42), { action: "bind" });
});
test("matching id is accepted (number or string bigint)", () => {
  assert.deepEqual(decideIdentity({ telegram_user_id: 42 }, 42), { action: "accept" });
  assert.deepEqual(decideIdentity({ telegram_user_id: "42" }, 42), { action: "accept" });
});
test("recycled handle with a different id is refused", () => {
  assert.deepEqual(decideIdentity({ telegram_user_id: 42 }, 43), { action: "refuse", reason: "id_mismatch" });
});
test("missing sender id is refused", () => {
  assert.deepEqual(decideIdentity({ telegram_user_id: null }, undefined), { action: "refuse", reason: "no_sender_id" });
});
