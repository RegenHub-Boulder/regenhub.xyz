import { describe, expect, it } from "vitest";

import { evaluateLockHealth } from "../../../../packages/shared/src/homeAssistant";

describe("evaluateLockHealth", () => {
  it("ignores a latched battery alarm when a fresh reading is clearly healthy", () => {
    expect(evaluateLockHealth("alive", "on", "98")).toBeUndefined();
  });

  it("keeps the battery warning when the reported percentage is low", () => {
    expect(evaluateLockHealth("alive", "on", "28")).toBe(
      "is low on battery (28%) — the change may not have applied",
    );
  });

  it.each([null, "unknown", "unavailable"])(
    "keeps the battery warning when the percentage is %s",
    (batteryLevel) => {
      expect(evaluateLockHealth("alive", "on", batteryLevel)).toBe(
        "is low on battery — the change may not have applied",
      );
    },
  );

  it("still reports a dead node when the battery alarm is stale", () => {
    expect(evaluateLockHealth("dead", "on", "98")).toBe(
      "was dead on the mesh — the change may not have applied",
    );
  });

  it("returns no warning for a healthy node without a battery alarm", () => {
    expect(evaluateLockHealth("alive", "off", "28")).toBeUndefined();
  });
});
