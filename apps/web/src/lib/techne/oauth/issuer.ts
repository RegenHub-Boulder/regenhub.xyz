/**
 * The check after every sign-in, before this server trusts the account (review of PR #122, H1): the account is a
 * did:plc, and the authorization server that issued its tokens is the one its own PDS names. So a token for DID X
 * only counts when it came from X's own PDS. The OAuth library checks the same thing in its code exchange; this is
 * this site's own copy, on the rule that decides who gets a portal session.
 *
 * DID document (PLC directory) → `#atproto_pds` → `/.well-known/oauth-protected-resource` → its first
 * authorization server → `/.well-known/oauth-authorization-server` → `issuer`, which must equal the token's issuer.
 */

import { isPlcDid, pdsOf, type DidResolver } from "../did";

export class IssuerError extends Error {}

async function getJson(url: string, f: typeof fetch): Promise<Record<string, unknown>> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new IssuerError(`not https: ${u.origin}`);
  const res = await f(u.toString(), {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) throw new IssuerError(`no answer from ${u.origin}`);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") throw new IssuerError(`bad answer from ${u.origin}`);
  return body;
}

export async function confirmIssuer(
  did: string,
  issuer: string | undefined,
  o: { resolve: DidResolver; fetch?: typeof fetch },
): Promise<void> {
  if (!isPlcDid(did)) throw new IssuerError("not a did:plc account");
  if (!issuer) throw new IssuerError("no issuer");
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const pds = pdsOf(await o.resolve(did).catch(() => null));
  if (!pds) throw new IssuerError("the DID names no PDS");
  const resource = await getJson(new URL("/.well-known/oauth-protected-resource", pds).toString(), f);
  const servers = resource.authorization_servers;
  const server = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : null;
  if (!server) throw new IssuerError("the PDS names no authorization server");
  const meta = await getJson(new URL("/.well-known/oauth-authorization-server", server).toString(), f);
  if (meta.issuer !== issuer) throw new IssuerError(`issuer ${issuer} is not ${did}'s PDS's (${String(meta.issuer)})`);
}
