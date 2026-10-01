import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getPending, setPending, clearPending, resetPending, type PendingAction } from "./pendingActions.js";

const CHAT = -100123;
const ADMIN = 5001;
const OTHER = 5002;

function flow(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    type: "quickcode",
    step: "awaiting_custom_time",
    data: { label: "guest" },
    timestamp: Date.now(),
    ownerId: ADMIN,
    ...overrides,
  };
}

beforeEach(() => resetPending());

test("the admin who opened the flow can continue it", () => {
  setPending(CHAT, flow());
  assert.equal(getPending(CHAT, ADMIN)?.type, "quickcode");
});

test("another user in the same group chat cannot continue it", () => {
  setPending(CHAT, flow());
  // The prompt went to the group, so anyone can reply into it — but only the
  // initiating admin's reply may complete the flow.
  assert.equal(getPending(CHAT, OTHER), null);
  // ...and the flow is still there, waiting for its owner.
  assert.equal(getPending(CHAT, ADMIN)?.type, "quickcode");
});

test("a message with no sender cannot continue it", () => {
  setPending(CHAT, flow());
  assert.equal(getPending(CHAT, undefined), null);
});

test("an empty chat is indistinguishable from someone else's flow", () => {
  assert.equal(getPending(CHAT, OTHER), null);
  setPending(CHAT, flow());
  assert.equal(getPending(CHAT, OTHER), null);
});

test("clearing removes the flow for its owner too", () => {
  setPending(CHAT, flow());
  clearPending(CHAT);
  assert.equal(getPending(CHAT, ADMIN), null);
});

test("flows in different chats are independent", () => {
  setPending(CHAT, flow());
  setPending(CHAT + 1, flow({ ownerId: OTHER, type: "addmember" }));
  assert.equal(getPending(CHAT, ADMIN)?.type, "quickcode");
  assert.equal(getPending(CHAT + 1, OTHER)?.type, "addmember");
  assert.equal(getPending(CHAT + 1, ADMIN), null);
});

test("advancing a step keeps the same owner", () => {
  setPending(CHAT, flow({ step: "awaiting_username", type: "addpasses" }));
  const p = getPending(CHAT, ADMIN)!;
  p.step = "awaiting_count";
  setPending(CHAT, p);
  assert.equal(getPending(CHAT, OTHER), null);
  assert.equal(getPending(CHAT, ADMIN)?.step, "awaiting_count");
});
