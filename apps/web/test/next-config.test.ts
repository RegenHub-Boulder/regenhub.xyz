import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("standalone runtime cache", () => {
  it("keeps ISR writes out of the executable server build", () => {
    expect(nextConfig.output).toBe("standalone");
    expect(nextConfig.experimental?.isrFlushToDisk).toBe(false);
    // The default memory cache must remain enabled to retain regenerated data.
    expect(nextConfig.cacheMaxMemorySize).not.toBe(0);
    expect(nextConfig.cacheHandler).toBeUndefined();
  });
});
