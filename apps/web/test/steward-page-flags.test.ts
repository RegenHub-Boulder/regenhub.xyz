/**
 * TECHNE_SIGNIN_ENABLED off keeps Manage Events exactly as before T-482 (the old regenOS-lane page at
 * /portal/events, its nav link, card and revalidate); on, the Techne door is /portal/events and the old
 * page stays at /portal/events/old ("Old steward page") while the regenOS lane is on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";

const revalidated: string[] = [];
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => revalidated.push(`path:${p}`),
  revalidateTag: (t: string) => revalidated.push(`tag:${t}`),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }),
}));

import { isStewardEventsEnabled } from "@/lib/techne/config";
import { OldStewardPage } from "@/components/portal/legacy/OldStewardPage";
import ManageEventsPage from "@/app/portal/events/page";
import OldManageEventsPage from "@/app/portal/events/old/page";
import { POST as revalidatePOST } from "@/app/api/portal/events/revalidate/route";

const isNotFound = (err: unknown) => String((err as { digest?: string })?.digest ?? "").includes("404");

function flags({ techne, login }: { techne: boolean; login: boolean }) {
  vi.stubEnv("REGENOS_BASE_URL", "https://techne.test");
  vi.stubEnv("REGENOS_COLLECTIVE_DID", "did:plc:hubflags");
  vi.stubEnv("TECHNE_SIGNIN_ENABLED", techne ? "true" : "");
  vi.stubEnv("REGENOS_LOGIN_ENABLED", login ? "true" : "");
}

beforeEach(() => {
  revalidated.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("Techne door off: as before", () => {
  it("/portal/events is the old page, its link and card show with the regenOS lane, and /portal/events/old doesn't exist", async () => {
    flags({ techne: false, login: true });
    const page = await ManageEventsPage();
    expect(isValidElement(page) && page.type).toBe(OldStewardPage);
    expect(isStewardEventsEnabled()).toBe(true);
    await expect(OldManageEventsPage()).rejects.toSatisfy(isNotFound);
  });

  it("revalidate drops `/` only, as before", async () => {
    flags({ techne: false, login: true });
    expect((await revalidatePOST()).status).toBe(200);
    expect(revalidated).toEqual(["path:/"]);
  });

  it("with the regenOS lane off too, there is no Manage Events at all", async () => {
    flags({ techne: false, login: false });
    expect(isStewardEventsEnabled()).toBe(false);
    expect((await revalidatePOST()).status).toBe(404);
    // /portal/events renders the old page, which 404s with its lane off, as before.
    await expect(OldStewardPage()).rejects.toSatisfy(isNotFound);
  });
});

describe("Techne door on", () => {
  it("the old page is still reachable at /portal/events/old", async () => {
    flags({ techne: true, login: true });
    const old = await OldManageEventsPage();
    expect(isValidElement(old) && old.type).toBe(OldStewardPage);
    expect(isStewardEventsEnabled()).toBe(true);
  });

  it("revalidate also expires the cached Techne reads", async () => {
    flags({ techne: true, login: false });
    expect((await revalidatePOST()).status).toBe(200);
    expect(revalidated).toEqual([expect.stringMatching(/^tag:/), "path:/"]);
  });
});
