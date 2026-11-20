import { describe, expect, it } from "vitest";
import { linkLabel, normalizeLinks } from "./memberDirectory";
import { parseProfile } from "./techne/profile";

describe("normalizeLinks", () => {
  it("takes typed links one per line, adds https, drops blanks and repeats", () => {
    expect(normalizeLinks("ana.example\n\n https://github.com/ana \nana.example")).toEqual({
      ok: true,
      links: ["https://ana.example/", "https://github.com/ana"],
    });
  });
  it("splits on spaces or comma-space too", () => {
    expect(normalizeLinks("a.example, b.example c.example")).toEqual({
      ok: true, links: ["https://a.example/", "https://b.example/", "https://c.example/"],
    });
  });
  it.each([["user:1password@evil.example"], ["https://me:pw@site.example"], ["javascript:alert(1)"], ["data:text/html,hi"], ["ftp://x.example"], ["localhost"], ["https://"]])("refuses %s", (bad) => {
    expect(normalizeLinks([bad]).ok).toBe(false);
  });
  it("keeps commas inside a URL and adds https to host:port", () => {
    expect(normalizeLinks("https://maps.example/@40.01,-105.27,15z\nsite.example:8080/work")).toEqual({
      ok: true,
      links: ["https://maps.example/@40.01,-105.27,15z", "https://site.example:8080/work"],
    });
  });
  it("refuses more than five", () => {
    expect(normalizeLinks(["a.example", "b.example", "c.example", "d.example", "e.example", "f.example"]).ok).toBe(false);
  });
  it("labels a link by host and path", () => {
    expect(linkLabel("https://www.github.com/ana/")).toBe("github.com/ana");
  });
});

describe("parseProfile", () => {
  const base = "https://techne.example";
  const did = "did:plc:anaprofile";
  it("makes the AppView's avatar path absolute", () => {
    expect(parseProfile(base, did, { did, displayName: " Ana ", bio: "", avatarUrl: `/xrpc/social.scenius.getAvatar?did=${did}&cid=bafy` }))
      .toEqual({ displayName: "Ana", bio: null, avatarUrl: `${base}/xrpc/social.scenius.getAvatar?did=${did}&cid=bafy` });
  });
  it("drops an avatar that isn't this DID's getAvatar on the AppView", () => {
    for (const avatarUrl of [
      "https://evil.example/a.png",
      "//evil.example/a.png",
      `/xrpc/social.scenius.getAvatar?did=did:plc:someoneelse&cid=bafy`,
      "/xrpc/other.method?did=" + did,
    ]) {
      expect(parseProfile(base, did, { did, avatarUrl })?.avatarUrl).toBeNull();
    }
  });
  it("refuses an answer about another DID", () => {
    expect(parseProfile(base, did, { did: "did:plc:other", displayName: "X" })).toBeNull();
  });
});
