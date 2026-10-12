/**
 * Post-login destination handling.
 *
 * `next` comes from a query string, so it is attacker-controlled. Only
 * same-origin relative paths are honoured: must start with a single "/",
 * never "//" or "/\" (protocol-relative / browser-normalised to another host),
 * no control characters, and no scheme.
 */
export const DEFAULT_NEXT = "/portal";

export function safeNextPath(raw: string | null | undefined): string | undefined {
  if (!raw || raw.length > 2048) return undefined;
  if (!raw.startsWith("/")) return undefined;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return undefined;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return undefined;
  // Resolve against a dummy origin: anything that escapes it is rejected.
  try {
    const base = "http://internal.invalid";
    const u = new URL(raw, base);
    if (u.origin !== base) return undefined;
  } catch {
    return undefined;
  }
  return raw;
}

/** `/auth/login`, carrying the destination when it is safe to carry. */
export function loginUrlFor(path: string | null | undefined): string {
  const next = safeNextPath(path);
  return next ? `/auth/login?next=${encodeURIComponent(next)}` : "/auth/login";
}
