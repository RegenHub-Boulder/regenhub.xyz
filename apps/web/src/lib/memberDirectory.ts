/**
 * The member directory (/members) and member pages (/members/<handle>), T-482. Aaron, 11-20: "A member page and a
 * place in the directory", on the member's Techne account, shown only if they opt in.
 *
 * Listed = opted in (`show_in_directory`, migration 065), not disabled, and a member in standing by the one
 * definition (lib/memberStanding.ts: hub friend or desk, or an active/trialing subscription at $30+). Co-op owners,
 * who were the whole directory before, also stay listed while opted in. A member who lapses or is disabled drops
 * out (their page 404s) and keeps their saved fields for when they're back.
 *
 * What's public is `PublicMember` and nothing else: name, photo, the "working on" line, bio, skills, links, the
 * Techne handle. Never email, plan, payment or door data; `toPublicMember` copies field by field so a new column
 * can't leak by being selected.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { handleFor } from "@/lib/techne/did";
import { fetchTechneProfile, type TechneProfile } from "@/lib/techne/profile";
import { PAYING_STATUSES, isMemberInStanding, type StandingSubscription } from "@/lib/memberStanding";

/** The columns the directory reads (server only; most never leave the server). */
export const DIRECTORY_COLUMNS =
  "id, name, did, bio, skills, profile_photo_url, working_on, links, show_rsvps, member_type, disabled, is_coop_member, show_in_directory";

export interface DirectoryRow {
  id: number;
  name: string;
  did: string | null;
  bio: string | null;
  skills: string[] | null;
  profile_photo_url: string | null;
  working_on: string | null;
  links: string[] | null;
  show_rsvps: boolean | null;
  member_type: string | null;
  disabled: boolean | null;
  is_coop_member: boolean | null;
  show_in_directory: boolean | null;
}

/** One member as the public sees them. */
export interface PublicMember {
  /** The page path segment: the verified Techne handle, else the member id. */
  slug: string;
  name: string;
  handle: string | null;
  photoUrl: string | null;
  workingOn: string | null;
  bio: string | null;
  skills: string[];
  links: { url: string; label: string }[];
}

/** Pure: is this member in the directory? */
export function isListed(
  m: Pick<DirectoryRow, "show_in_directory" | "disabled" | "is_coop_member" | "member_type">,
  subs: readonly StandingSubscription[],
): boolean {
  if (m.show_in_directory !== true || m.disabled) return false;
  return !!m.is_coop_member || isMemberInStanding(m, subs);
}

/** Every listed member, by name. Throws on a failed read (the caller decides how to degrade). */
export async function listedMembers(client: SupabaseClient): Promise<DirectoryRow[]> {
  const { data: rows, error } = await client
    .from("members")
    .select(DIRECTORY_COLUMNS)
    .eq("show_in_directory", true)
    .eq("disabled", false)
    .order("name");
  if (error) throw error;
  const members = (rows ?? []) as DirectoryRow[];
  if (members.length === 0) return [];
  const { data: subs, error: subErr } = await client
    .from("subscriptions")
    .select("member_id, status, monthly_cents")
    .in("member_id", members.map((m) => m.id))
    .in("status", PAYING_STATUSES);
  if (subErr) throw subErr;
  const byMember = new Map<number, StandingSubscription[]>();
  for (const s of (subs ?? []) as (StandingSubscription & { member_id: number })[]) {
    byMember.set(s.member_id, [...(byMember.get(s.member_id) ?? []), s]);
  }
  return members.filter((m) => isListed(m, byMember.get(m.id) ?? []));
}

export const MAX_LINKS = 5;
export const WORKING_ON_MAX = 140;

/** Pure: a link list as typed (array, or text one per line) → clean http(s) URLs, or an error to show. A URL may
 *  hold commas, so text splits on newlines only. */
export function normalizeLinks(input: unknown): { ok: true; links: string[] } | { ok: false; error: string } {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/\r?\n/) : input == null ? [] : null;
  if (raw === null) return { ok: false, error: "Links must be a list of URLs." };
  const links: string[] = [];
  for (const item of raw) {
    const s = typeof item === "string" ? item.trim() : "";
    if (!s) continue;
    let url: URL;
    try {
      // A scheme is letters then ":" not followed by a digit, so "site.example:8080" gets https:// added.
      url = new URL(/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) ? s : `https://${s}`);
    } catch {
      return { ok: false, error: `"${s.slice(0, 60)}" isn't a link.` };
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname.includes(".") || s.length > 200) {
      return { ok: false, error: `"${s.slice(0, 60)}" isn't a web link.` };
    }
    if (!links.includes(url.toString())) links.push(url.toString());
  }
  if (links.length > MAX_LINKS) return { ok: false, error: `Up to ${MAX_LINKS} links.` };
  return { ok: true, links };
}

/** Pure: what a link shows as: its host and path, without the scheme, "www." or a trailing slash. */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return `${u.hostname.replace(/^www\./, "")}${path}`.slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}

/** Only http(s) image URLs are shown; anything else is dropped. */
const safeImage = (url: string | null | undefined): string | null =>
  url && /^https?:\/\//i.test(url) ? url : null;

/** Pure: a listed row (+ its Techne handle and profile) → what the public sees. Field by field, on purpose. */
export function toPublicMember(row: DirectoryRow, handle: string | null, profile: TechneProfile | null): PublicMember {
  return {
    slug: handle ?? String(row.id),
    name: row.name,
    handle,
    photoUrl: safeImage(row.profile_photo_url) ?? safeImage(profile?.avatarUrl),
    workingOn: row.working_on?.trim() || null,
    bio: row.bio?.trim() || null,
    skills: (row.skills ?? []).filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()),
    links: (row.links ?? [])
      .filter((u) => /^https?:\/\//i.test(u))
      .map((url) => ({ url, label: linkLabel(url) })),
  };
}

async function techneOf(row: DirectoryRow): Promise<{ handle: string | null; profile: TechneProfile | null }> {
  if (!row.did) return { handle: null, profile: null };
  const [handle, profile] = await Promise.all([handleFor(row.did).catch(() => null), fetchTechneProfile(row.did)]);
  return { handle, profile };
}

/** The public directory: listed members (the first `limit`, if given), as the public sees them. */
export async function publicDirectory(client: SupabaseClient, limit?: number): Promise<PublicMember[]> {
  const rows = (await listedMembers(client)).slice(0, limit);
  const techne = await Promise.all(rows.map(techneOf));
  return rows.map((row, i) => toPublicMember(row, techne[i].handle, techne[i].profile));
}

export type MemberPageLookup =
  | { kind: "found"; member: PublicMember; did: string | null; showRsvps: boolean }
  | { kind: "redirect"; slug: string }
  | { kind: "none" };

/**
 * The listed member a page slug names: a verified Techne handle, or a member id. Only listed members are found;
 * anyone else is `none` (a 404, the same for "not a member", "not opted in", "lapsed" and "no such person").
 * A linked member reached by id is sent to their handle. The handle is matched against listed members' own
 * verified handles, so a slug never makes this server look up an arbitrary host.
 */
export async function findMemberPage(client: SupabaseClient, slug: string): Promise<MemberPageLookup> {
  const s = decodeURIComponent(slug).trim().toLowerCase().replace(/^@/, "");
  if (!s || s.length > 253) return { kind: "none" };
  const rows = await listedMembers(client);
  let row: DirectoryRow | undefined;
  let handle: string | null = null;
  if (/^\d{1,10}$/.test(s)) {
    row = rows.find((r) => String(r.id) === s);
    if (!row) return { kind: "none" };
    handle = row.did ? await handleFor(row.did).catch(() => null) : null;
    if (handle) return { kind: "redirect", slug: handle };
  } else {
    if (!/^[a-z0-9.-]+$/.test(s)) return { kind: "none" };
    const linked = rows.filter((r) => r.did);
    const handles = await Promise.all(linked.map((r) => handleFor(r.did as string).catch(() => null)));
    const i = handles.findIndex((h) => h?.toLowerCase() === s);
    if (i < 0) return { kind: "none" };
    row = linked[i];
    handle = handles[i];
  }
  const profile = row.did ? await fetchTechneProfile(row.did) : null;
  return { kind: "found", member: toPublicMember(row, handle, profile), did: row.did, showRsvps: !!row.show_rsvps };
}
