/** A signed-in Techne session as techne-sdk/auth gives it: the person's DID and a signing fetch. */
export interface Session {
  did: string;
  fetchHandler: (path: string, init: RequestInit) => Promise<Response>;
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
  if (!res.ok) throw new Error(`${nsid} answered ${res.status}`);
  return res.json().catch(() => ({}));
}
