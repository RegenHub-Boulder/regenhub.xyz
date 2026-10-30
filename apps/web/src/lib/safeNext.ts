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
  // Resolve against a dummy origin: anything that escapes it is rejected. Dot
  // segments ("/.//evil.com", "/%2e//evil.com") resolve to a path starting "//",
  // which a browser reads as another host, so reject that too and hand back the
  // resolved path: what is checked is what gets followed.
  try {
    const base = "http://internal.invalid";
    const u = new URL(raw, base);
    if (u.origin !== base || u.pathname.startsWith("//")) return undefined;
    return u.pathname + u.search + u.hash;
  } catch {
    return undefined;
  }
}

/** `/auth/login`, carrying the destination when it is safe to carry. */
export function loginUrlFor(path: string | null | undefined): string {
  const next = safeNextPath(path);
  return next ? `/auth/login?next=${encodeURIComponent(next)}` : "/auth/login";
}
