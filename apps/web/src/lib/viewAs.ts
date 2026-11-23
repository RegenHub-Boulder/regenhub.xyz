/**
 * "View the portal as…" (T-482): an admin opens /portal as a kind of member (a fictional one built from
 * lib/portalFixtures.ts) or as one real member, read-only.
 *
 * The state is one httpOnly cookie, `rh_view_as`, set only by POST /api/admin/view-as after the live admin check.
 * It names the view, the admin's auth user id and an expiry (one hour). It carries no authority: every read of it
 * (lib/viewAsServer.ts `currentViewAs`) checks again that the signed-in user is that admin and still an active admin,
 * so a hand-made cookie shows nothing. What it does do, for anyone holding it, is pause writes: the proxy (src/proxy.ts)
 * refuses every write request while it is set (`viewAsRefuses`), before any route or server action runs.
 *
 * This file is pure (no Next or Supabase imports): the proxy runs it.
 */

export const VIEW_AS_COOKIE = "rh_view_as";
export const VIEW_AS_TTL_SECONDS = 60 * 60;
/** Entering or switching a preview (admins only), and leaving it (anyone holding the cookie): open while one is on. */
export const VIEW_AS_ROUTE = "/api/admin/view-as";
export const VIEW_AS_EXIT = "/api/view-as/exit";

export type ViewAsTarget = { kind: "fixture"; key: string } | { kind: "member"; memberId: number };
export interface ViewAsCookie {
  target: ViewAsTarget;
  adminUserId: string;
  expiresAt: number;
}

const FIXTURE_KEY = /^[a-z0-9-]{1,40}$/;
const UUIDISH = /^[0-9a-f-]{8,64}$/i;

export function viewAsCookieValue(target: ViewAsTarget, adminUserId: string, nowMs: number): string {
  const view = target.kind === "fixture" ? `fixture:${target.key}` : `member:${target.memberId}`;
  return [view, adminUserId, String(nowMs + VIEW_AS_TTL_SECONDS * 1000)].join("|");
}

/** The cookie, or null when it is malformed or expired. Says nothing about who may use it. */
export function parseViewAsCookie(raw: string | null | undefined, nowMs: number): ViewAsCookie | null {
  if (!raw) return null;
  const [view, adminUserId, exp, ...rest] = raw.split("|");
  if (rest.length || !view || !adminUserId || !UUIDISH.test(adminUserId)) return null;
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return null;
  const [kind, value] = view.split(":");
  if (kind === "fixture" && value && FIXTURE_KEY.test(value)) {
    return { target: { kind: "fixture", key: value }, adminUserId, expiresAt };
  }
  if (kind === "member" && value && /^[1-9][0-9]{0,9}$/.test(value)) {
    return { target: { kind: "member", memberId: Number(value) }, adminUserId, expiresAt };
  }
  return null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** GET routes and pages that change something (they predate this rule); refused in a preview like any write. */
const WRITING_GETS = [
  "/api/portal/invite", // makes the member's invite code on first read
  "/api/newsletter/unsubscribe", // one-click unsubscribe
  "/api/cron/", // every cron job (bearer-gated anyway)
  "/xrpc/", // the regenOS proxy
  "/freeday", // the page links a member row and expires old claims as it renders
];

/** Signing in (starting it, or its callback) ends a preview rather than being refused: whoever signs in next on this
 *  browser must not be left read-only. The proxy lets these through and drops the cookie. */
const SIGN_INS = ["/auth/callback", "/techne/callback", "/techne/signin"];

/** The path as a route would match it: percent-decoded, repeated and trailing slashes collapsed. */
function normalPath(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // A malformed escape: match it as written (no route has one).
  }
  return path.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
}

/** Whether this request signs someone in: the preview ends with it (see SIGN_INS). */
export function viewAsEndsWith(pathname: string): boolean {
  return SIGN_INS.includes(normalPath(pathname));
}

/**
 * Whether a request must be refused while a preview cookie is set: every POST/PUT/PATCH/DELETE (API routes, server
 * actions, form posts) except entering/leaving the preview, signing out and signing in, and the few GETs that write.
 * Default deny, so a route added later is covered without being listed.
 */
export function viewAsRefuses(method: string, pathname: string): boolean {
  const path = normalPath(pathname);
  if (SIGN_INS.includes(path)) return false;
  if (SAFE_METHODS.has(method.toUpperCase())) {
    return WRITING_GETS.some((p) => (p.endsWith("/") ? path.startsWith(p) || path === p.slice(0, -1) : path === p));
  }
  if (path === VIEW_AS_ROUTE || path === VIEW_AS_EXIT) return false;
  if (path === "/auth/signout") return false;
  return true;
}

export const VIEW_AS_REFUSAL = "Read-only preview: nothing can be changed while you view the portal as someone else. Exit the preview first.";
