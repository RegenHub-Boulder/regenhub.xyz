/**
 * A person's public Techne profile (display name, bio, avatar), read anonymously from the AppView's
 * `social.scenius.getProfile?did=` (the `coop.lexicon.profile` record, rkey `self`). Its `avatarUrl` is a path on the
 * AppView (`/xrpc/social.scenius.getAvatar?did=…&cid=…`, served only for a blob a public record of that DID names),
 * made absolute here. Null on any failure, never throws: a member page falls back to what the member saved here.
 * The handle in the answer is the AppView's word; pages use `handleFor` (verified both ways) instead.
 */

import { REGENOS_TIMEOUT_MS, regenosBaseUrl } from "@/lib/regenos/config";
import { isPlcDid } from "./did";
import { TECHNE_READS_TAG } from "./query";

export interface TechneProfile {
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
}

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** Pure: the answer → a profile. The avatar must be an AppView getAvatar path for this same DID. */
export function parseProfile(base: string, did: string, body: unknown): TechneProfile | null {
  const b = body as { did?: unknown; displayName?: unknown; bio?: unknown; avatarUrl?: unknown } | null;
  if (!b || b.did !== did) return null;
  let avatarUrl: string | null = null;
  if (typeof b.avatarUrl === "string" && b.avatarUrl.startsWith("/xrpc/social.scenius.getAvatar?")) {
    const url = new URL(b.avatarUrl, base);
    if (url.searchParams.get("did") === did) avatarUrl = url.toString();
  }
  return { displayName: text(b.displayName, 64), bio: text(b.bio, 500), avatarUrl };
}

export async function fetchTechneProfile(did: string, opts: { revalidate?: number; timeoutMs?: number } = {}): Promise<TechneProfile | null> {
  const base = regenosBaseUrl();
  if (!base || !isPlcDid(did)) return null;
  const revalidate = opts.revalidate ?? 600;
  try {
    const res = await fetch(`${base}/xrpc/social.scenius.getProfile?${new URLSearchParams({ did })}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? REGENOS_TIMEOUT_MS),
      ...(revalidate > 0 ? { next: { revalidate, tags: [TECHNE_READS_TAG] } } : { cache: "no-store" as const }),
    });
    if (!res.ok) return null;
    return parseProfile(base, did, await res.json());
  } catch {
    return null;
  }
}
