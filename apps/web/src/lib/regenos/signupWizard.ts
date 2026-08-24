/**
 * The regenOS signup wizard's wire contract — the four calls the emailed
 * magic link lands on, plus the handle rules, as pure functions.
 *
 * ── Why this module exists at all ─────────────────────────────────────────
 * `RegenosLoginPanel`'s email door POSTs `beginSignup`. In PROD (email mode)
 * an email regenOS has never seen comes back `stage: "checkEmail"` and the
 * AppView MAILS a link at `<app_base_url>/login?token=…` — i.e. at THIS app,
 * once regenhub.xyz is the configured base. Clicking it used to 404: this app
 * served no `/login`. Since most RegenHub members have no regenOS account yet,
 * that dead end was the majority path, not an edge.
 *
 * `/login` is therefore the SECOND half of the same wizard: the link's `token`
 * resumes the pending signup and the person picks a handle. The sequence
 * mirrors regenOS's own `apps/scenius-web/src/lib/{signup.ts,use-signup-wizard.ts}`
 * byte-for-byte — deviating would mean this app and scenius disagree about the
 * same AppView:
 *
 *     verifySignup ─▶ setSignupProfile ─▶ createCustodialAccount ─▶ finishSession
 *
 * The whole pre-mint half runs PENDING-COOKIE-authed — there is no session yet.
 * `beginSignup` set the sealed `__Host-rs_pending` cookie on THIS origin (via
 * the `/xrpc` proxy — `app/xrpc/[...nsid]/route.ts` explains why a same-origin
 * proxy is the only way a `__Host-` cookie can land here), every step below
 * reads it, and the real `__Host-rs_session` cookie is minted ONLY by
 * `createCustodialAccount`. That cookie-binding is also why a link opened on a
 * DIFFERENT device than the one that started the signup cannot resume: there's
 * no pending cookie there to bind the token to. The failure copy says so.
 *
 * Split out of the component (same reason as `lib/regenos/oauth.ts`) because
 * this repo's vitest runs in a `node` environment with no jsdom or
 * @testing-library — testable logic has to live outside the JSX. Every call
 * takes an injectable `fetchImpl` for exactly that.
 *
 * Same-origin `fetch` sends cookies by default and `RegenosLoginPanel` relies
 * on that, so these do too — no `credentials` option, deliberately.
 */

/** Handle length cap — matches the AppView's too-long boundary (scenius `MAX_HANDLE`). */
export const MAX_HANDLE = 18;

/** Allowed handle characters: lowercase letters, digits, hyphens — the shape the AppView accepts. */
export const HANDLE_OK = /^[a-z0-9-]+$/;

const NSID_VERIFY_SIGNUP = "social.scenius.verifySignup";
const NSID_SET_SIGNUP_PROFILE = "social.scenius.setSignupProfile";
const NSID_CREATE_CUSTODIAL_ACCOUNT = "social.scenius.createCustodialAccount";
const NSID_CHECK_HANDLE = "social.scenius.checkHandle";

/** The regenHub handoff both regenOS doors finish through (`RegenosLoginPanel.finish()`). */
const SESSION_HANDOFF_PATH = "/api/auth/regenos/session";

/** The atproto-shaped XRPC error body the AppView returns on a non-2xx (cf. `lib/regenos/oauth.ts`). */
interface XrpcErrorBody {
  error?: string;
  message?: string;
}

/**
 * Why a wizard step didn't advance:
 *   - `invalid_link`  — the token was bad/expired, or there's no pending cookie on THIS browser.
 *   - `handle_taken`  — the 409 `HandleTaken` backstop: the label was raced between the probe and the mint.
 *   - `rejected`      — any other AppView refusal (reserved/invalid label, expired pending session).
 *   - `unreachable`   — the call never landed (network, timeout, proxy 502).
 */
export type WizardErrorReason = "invalid_link" | "handle_taken" | "rejected" | "unreachable";

export interface WizardFailure {
  ok: false;
  reason: WizardErrorReason;
  message: string;
}

/** Warm copy for a call that never landed — same posture as every other regenOS call in this app. */
const UNREACHABLE = "Couldn't reach regenOS right now. Try again in a moment.";

/**
 * The link failed. Deliberately NOT the AppView's own wording ("no pending signup in progress"),
 * which is true but unreadable to a member: the two real causes are an expired/reused token and a
 * link opened somewhere the pending cookie isn't, so we name both.
 */
export const LINK_FAILED_MESSAGE =
  "That sign-in link didn't work — it may have expired, or you may have opened it on a different device than the one you started on.";

function unreachable(): WizardFailure {
  return { ok: false, reason: "unreachable", message: UNREACHABLE };
}

/** Parse an XRPC error body, tolerating a non-JSON body (a proxy 502 is HTML-ish, not a lexicon error). */
async function errorBody(res: Response): Promise<XrpcErrorBody | null> {
  return (await res.json().catch(() => null)) as XrpcErrorBody | null;
}

/**
 * Map a failed handle write to a reason + message. The 409 `HandleTaken` leg is the exact-or-fail
 * mint backstop (onboarding.rs `map_mint_error`): the AppView NEVER silently renames you to
 * `<label>2`, it refuses and puts the suggestion in its message — so we lead with a warm "pick
 * another" and append the server's line so the offer survives.
 */
function handleFailure(body: XrpcErrorBody | null, status: number): WizardFailure {
  if (status === 409 && body?.error === "HandleTaken") {
    return {
      ok: false,
      reason: "handle_taken",
      message: `That name was just taken — pick another. ${body.message ?? ""}`.trim(),
    };
  }
  // Everything else the AppView says here is already plain enough to show as-is
  // (reserved / invalid / "you've already chosen your handle").
  return {
    ok: false,
    reason: "rejected",
    message: body?.message || "That name didn't work — try another.",
  };
}

// ── Step 1: redeem the emailed token ─────────────────────────────────────────────────────────────

/**
 * `GET verifySignup` — consume the single-use token AND bind it to this browser's
 * `__Host-rs_pending` cookie (onboarding.rs `verify_signup`). Success is `{ stage: "chooseHandle" }`.
 *
 * A 400 covers both real causes (bad/expired token, missing pending cookie) and gets the one warm
 * message above; the AppView's own copy isn't surfaced because it can't tell a member which of the
 * two happened either.
 */
export async function verifySignup(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | WizardFailure> {
  let res: Response;
  try {
    res = await fetchImpl(`/xrpc/${NSID_VERIFY_SIGNUP}?token=${encodeURIComponent(token)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return unreachable();
  }
  if (!res.ok) {
    return { ok: false, reason: "invalid_link", message: LINK_FAILED_MESSAGE };
  }
  return { ok: true };
}

// ── Step 2: capture the chosen label ─────────────────────────────────────────────────────────────

/**
 * `POST setSignupProfile` — store the validated base label on the pending row; the AppView echoes
 * the full `<label>.<domain>` it will mint. Bio is deliberately omitted: RegenHub's portal has its
 * own profile, and one field is one field too many on a sign-in path.
 */
export async function setSignupProfile(
  label: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; handle: string } | WizardFailure> {
  let res: Response;
  try {
    res = await fetchImpl(`/xrpc/${NSID_SET_SIGNUP_PROFILE}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ handle: label.trim() }),
    });
  } catch {
    return unreachable();
  }
  if (!res.ok) return handleFailure(await errorBody(res), res.status);
  const json = (await res.json().catch(() => null)) as { handle?: string } | null;
  return { ok: true, handle: json?.handle ?? label.trim() };
}

// ── Step 3: the mint (this is what lands the real session cookie) ────────────────────────────────

/**
 * `POST createCustodialAccount` — the single relocated PLC op. On success the AppView sets the real
 * `__Host-rs_session` cookie, which our `/xrpc` proxy relays onto regenhub.xyz; only after that does
 * the RegenHub handoff below have a session to read.
 */
export async function createCustodialAccount(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; handle: string; did: string } | WizardFailure> {
  let res: Response;
  try {
    res = await fetchImpl(`/xrpc/${NSID_CREATE_CUSTODIAL_ACCOUNT}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({}),
    });
  } catch {
    return unreachable();
  }
  if (!res.ok) return handleFailure(await errorBody(res), res.status);
  const json = (await res.json().catch(() => null)) as { handle?: string; did?: string } | null;
  return { ok: true, handle: json?.handle ?? "", did: json?.did ?? "" };
}

// ── Step 4: the shared RegenHub handoff ──────────────────────────────────────────────────────────

interface SessionResponse {
  ok?: boolean;
  member?: boolean;
  redirect?: string;
  error?: string;
}

/**
 * `POST /api/auth/regenos/session` — the SAME handoff both existing regenOS doors run
 * (`RegenosLoginPanel.finish()`, `OAuthCallback`): match the verified email to a membership, link
 * the DID, mint the Supabase session. No member match is not an error — that's a participant, and
 * the route says where to send them.
 */
export async function finishSession(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; redirect: string } | WizardFailure> {
  let res: Response;
  let data: SessionResponse;
  try {
    res = await fetchImpl(SESSION_HANDOFF_PATH, { method: "POST" });
    data = ((await res.json().catch(() => null)) ?? {}) as SessionResponse;
  } catch {
    return { ok: false, reason: "unreachable", message: "Couldn't reach RegenHub. Try again in a moment." };
  }
  if (!res.ok || !data.ok) {
    return {
      ok: false,
      reason: "rejected",
      message: data.error ?? "Couldn't finish signing you in.",
    };
  }
  return { ok: true, redirect: data.member ? "/portal" : (data.redirect ?? "/membership") };
}

// ── The live availability probe (nice-to-have, never load-bearing) ───────────────────────────────

/**
 * The probe's answer. `unknown` is NEUTRAL — "we couldn't check", never "available" and never
 * "taken". Only a KNOWN `taken` (or an in-flight `checking`, tracked by the caller) may gate submit;
 * the AppView stays the final word via the 409 backstop above.
 */
export type HandleProbeStatus = "idle" | "free" | "taken" | "unknown";

export interface HandleProbe {
  status: HandleProbeStatus;
  /** The AppView's `<label>2.<domain>` offer, present only when `status === "taken"`. */
  suggestion?: string;
  /** The full `<label>.<domain>` the label resolves to, echoed back on a 200. */
  handle?: string;
}

/**
 * `GET checkHandle` — a PUBLIC, pre-auth availability read (change_handle.rs `check_handle`). A
 * label someone else holds is a **200 `available:false`** with a suggestion, not an error; a 400 is
 * a true syntax/reserved problem, which our own `validateHandle` already speaks to, so it lands
 * `idle` rather than echoing the server twice. Anything else is a blip ⇒ `unknown`.
 */
export async function probeHandle(
  label: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HandleProbe> {
  let res: Response;
  try {
    res = await fetchImpl(`/xrpc/${NSID_CHECK_HANDLE}?handle=${encodeURIComponent(label.trim())}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return { status: "unknown" };
  }
  if (res.status === 400) return { status: "idle" };
  if (!res.ok) return { status: "unknown" };
  const json = (await res.json().catch(() => null)) as
    | { handle?: string; available?: boolean; suggestion?: string }
    | null;
  if (!json || typeof json.available !== "boolean") return { status: "unknown" };
  return json.available
    ? { status: "free", handle: json.handle }
    : { status: "taken", suggestion: json.suggestion, handle: json.handle };
}

// ── Local handle validation (the same rules, before we spend a round-trip) ───────────────────────

export type HandleProblem = "empty" | "tooLong" | "badChars";

export type HandleValidation =
  | { ok: true; label: string }
  | { ok: false; problem: HandleProblem; message: string };

/**
 * Validate a typed label locally. Purely a fast-feedback + probe gate — the AppView revalidates
 * everything (and owns reserved words, which we deliberately don't mirror: a duplicated reserved
 * list would drift).
 *
 * NEVER call this on a label derived from the email local-part: the handle field starts blank and
 * is never seeded from the email. That's regenOS's own §6.3 rule — the address is the person's free
 * choice, and pre-filling it is exactly the leak the pre-auth flow exists to prevent.
 */
export function validateHandle(raw: string): HandleValidation {
  const label = raw.trim();
  if (label.length === 0) {
    return { ok: false, problem: "empty", message: "Pick a name to finish." };
  }
  if (label.length > MAX_HANDLE) {
    return {
      ok: false,
      problem: "tooLong",
      message: `Keep it to ${MAX_HANDLE} characters or fewer.`,
    };
  }
  if (!HANDLE_OK.test(label)) {
    return {
      ok: false,
      problem: "badChars",
      message: "Lowercase letters, numbers, and hyphens only.",
    };
  }
  return { ok: true, label };
}
