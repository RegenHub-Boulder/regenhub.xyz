import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramIlikePatterns } from "./telegram.js";

test("strips a leading @ from the Telegram input", () => {
  assert.deepEqual(telegramIlikePatterns("@owocki"), { bare: "owocki", withAt: "@owocki" });
});

test("bare input yields both stored forms so a row without @ still matches", () => {
  // michaelgreen06 is stored WITHOUT a leading @ — this is the case that
  // locked admins out of /quickcode.
  assert.deepEqual(telegramIlikePatterns("michaelgreen06"), {
    bare: "michaelgreen06",
    withAt: "@michaelgreen06",
  });
});

test("escapes LIKE metacharacters so _ is literal, not a wildcard", () => {
  const p = telegramIlikePatterns("vibe_temple");
  assert.equal(p?.bare, "vibe\\_temple");
  assert.equal(p?.withAt, "@vibe\\_temple");
});

test("escapes % and backslash too", () => {
  assert.equal(telegramIlikePatterns("a%b\\c")?.bare, "a\\%b\\\\c");
});

test("empty or @-only input returns null (no match attempted)", () => {
  assert.equal(telegramIlikePatterns(""), null);
  assert.equal(telegramIlikePatterns("@"), null);
  assert.equal(telegramIlikePatterns("   "), null);
});
