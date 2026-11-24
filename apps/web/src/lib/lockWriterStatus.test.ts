import { describe, expect, it } from "vitest";
import { lockWriterStatus, recentLockWriteFailures } from "./lockWriterStatus";

const fmt = (iso: string) => iso.slice(11, 16);
const now = Date.parse("2026-11-23T18:00:00Z");

describe("lockWriterStatus", () => {
  it("is nothing when nobody holds the writer", () => {
    expect(lockWriterStatus(null, now, fmt)).toBeNull();
  });
  it("a writer that renewed inside the lease is running, however long ago it started", () => {
    const s = lockWriterStatus({ holder_label: "Web PIN writer", acquired_at: "2026-11-23T17:50:00Z", renewed_at: "2026-11-23T17:59:30Z" }, now, fmt);
    expect(s).toMatchObject({ state: "running", text: "A door-code change is running (Web PIN writer, since 17:50)." });
  });
  it("a writer silent past the lease is stuck, and the page says the next change takes it over", () => {
    const s = lockWriterStatus({ holder_label: "Web PIN writer", acquired_at: "2026-11-20T22:52:00Z", renewed_at: "2026-11-20T22:52:10Z" }, now, fmt);
    expect(s?.state).toBe("stuck");
    expect(s?.text).toContain("The next door-code change takes it over");
  });
  it("before migration 070 (no renewed_at) it doesn't promise a recovery that can't happen", () => {
    const s = lockWriterStatus({ holder_label: "Web PIN writer", acquired_at: "2026-11-20T22:52:00Z" }, now, fmt);
    expect(s?.state).toBe("stuck");
    expect(s?.text).toContain("Until migration 070 runs");
  });
});

it("recentLockWriteFailures words busy and part-way failures", () => {
  expect(recentLockWriteFailures([
    { created_at: "2026-11-23T17:00:00Z", payload: { holder: "Web PIN writer", busy: true, held_by: "Bot PIN writer", held_since: "2026-11-23T16:59:00Z" } },
    { created_at: "2026-11-23T16:00:00Z", payload: { holder: "Bot PIN writer", error: "fetch failed" } },
  ], fmt).map((f) => f.line)).toEqual([
    "17:00: Web PIN writer couldn't start: the writer was held by Bot PIN writer since 16:59.",
    "16:00: Bot PIN writer stopped part-way (fetch failed).",
  ]);
});
