/** A signed-in Techne session as techne-sdk/auth gives it: the person's DID and a signing fetch. */
export interface Session {
  did: string;
  fetchHandler: (path: string, init: RequestInit) => Promise<Response>;
}

/** A call the PDS or the platform answered with an error: its HTTP status and XRPC error name. */
export class XrpcError extends Error {
  constructor(
    readonly nsid: string,
    readonly status: number,
    readonly error: string | undefined,
    message: string | undefined,
    /** The `error` a `WWW-Authenticate` challenge named (OAuth's way of naming a bad token), if any. */
    readonly challenge?: string,
  ) {
    super(message ? `${nsid}: ${message}` : `${nsid} answered ${status}${error ? ` ${error}` : ""}`);
  }
}

/** One XRPC call over the person's session (their PDS; `proxy` forwards it to the platform). */
export async function sessionCall(
  session: Session,
  nsid: string,
  init: { body?: unknown; query?: Record<string, string>; proxy?: string },
): Promise<unknown> {
  const qs = init.query ? `?${new URLSearchParams(init.query)}` : "";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.proxy) headers["atproto-proxy"] = init.proxy;
  const res = await session.fetchHandler(`/xrpc/${nsid}${qs}`, {
    method: init.body !== undefined ? "POST" : "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    // OAuth resource servers name a bad token in WWW-Authenticate (`DPoP error="invalid_token"`), not the body.
    const auth = res.headers.get("www-authenticate") ?? "";
    const param = (k: string) => new RegExp(`\\b${k}=(?:"([^"]*)"|([^\\s,]+))`).exec(auth)?.slice(1).find((v) => v !== undefined);
    const challenge = param("error");
    throw new XrpcError(nsid, res.status, body?.error ?? challenge, body?.message ?? param("error_description"), challenge);
  }
  return res.json().catch(() => ({}));
}
