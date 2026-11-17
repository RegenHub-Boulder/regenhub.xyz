/**
 * STAGING ONLY: a stand-in for a Techne PDS's OAuth, for the tailnet preview,
 * where no real PDS can reach the preview's client metadata and production
 * Techne is off limits.
 *
 * techne-sdk/auth lets tests and other runtimes inject their own OAuth client
 * (`setOAuthClientFactory`). This one sends sign-in to the stand-in's "pick a
 * sample person" page and gives back a session whose `fetchHandler` talks to
 * the stand-in (app/staging/techne). Everything after sign-in (the RSVP
 * putRecord, the indexRecord hint, the read back) is the code production runs.
 */

import type { OAuthClientLike } from "techne-sdk/auth";

const KEY = "regenhub.techneStandInDid";

type Win = Pick<Window, "location" | "localStorage"> & { fetch: typeof fetch };

export function standInSession(base: string, did: string, win: Pick<Win, "fetch"> = globalThis as never) {
  return {
    did,
    sub: did,
    fetchHandler: (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("x-standin-did", did);
      return win.fetch(`${base}${path}`, { ...init, headers });
    },
  };
}

export function standInClient(base: string, win: Win): OAuthClientLike {
  return {
    async init() {
      const url = new URL(win.location.href);
      const did = url.searchParams.get("standin_did");
      if (did) {
        win.localStorage.setItem(KEY, did);
        return { session: standInSession(base, did, win) as never, state: url.searchParams.get("state") };
      }
      const kept = win.localStorage.getItem(KEY);
      return kept ? { session: standInSession(base, kept, win) as never } : undefined;
    },
    async signInRedirect(_input, options) {
      const go = new URL(`${base}/signin`, win.location.origin);
      go.searchParams.set("redirect", new URL("/techne/callback", win.location.origin).toString());
      if (options?.state) go.searchParams.set("state", String(options.state));
      win.location.assign(go.toString());
    },
    async revoke() {
      win.localStorage.removeItem(KEY);
    },
  };
}
