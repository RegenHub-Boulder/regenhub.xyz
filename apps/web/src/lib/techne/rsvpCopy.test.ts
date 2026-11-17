import { afterEach, describe, expect, it, vi } from "vitest";
import { eventDetailsLinkText, eventsPageRsvpLine } from "./rsvpCopy";

function setEnv(on: boolean) {
  vi.stubEnv("TECHNE_SIGNIN_ENABLED", on ? "true" : "");
  vi.stubEnv("REGENOS_BASE_URL", "https://regenos.example");
  vi.stubEnv("REGENOS_COLLECTIVE_DID", "did:plc:abc");
}

afterEach(() => vi.unstubAllEnvs());

describe("RSVP public copy follows the flag", () => {
  it("offers RSVP when on", () => {
    setEnv(true);
    expect(eventsPageRsvpLine()).toMatch(/RSVP/);
    expect(eventDetailsLinkText()).toBe("Details and RSVP →");
  });
  it("never mentions RSVP when off", () => {
    setEnv(false);
    expect(eventsPageRsvpLine()).not.toMatch(/RSVP/);
    expect(eventDetailsLinkText()).toBe("Details →");
  });
});
