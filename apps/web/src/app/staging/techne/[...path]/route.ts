import { NextResponse, type NextRequest } from "next/server";
import { isStandInEnabled } from "@/lib/techne/config";

/**
 * STAGING ONLY: carries the browser's "Sign in with Techne" stand-in calls
 * (lib/techne/standIn.ts) to the stand-in for a person's PDS
 * (scripts/staging/techne-standin.mjs). 404 unless TECHNE_STAGING_STANDIN is
 * on, which isStandInEnabled() refuses for the regenhub.xyz origin.
 */
export const dynamic = "force-dynamic";

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const target = process.env.TECHNE_STANDIN_URL?.trim();
  if (!isStandInEnabled() || !target) return NextResponse.json({ error: "NotFound" }, { status: 404 });
  const path = (await ctx.params).path.join("/");
  if (!/^(signin|xrpc\/[A-Za-z0-9.]+)$/.test(path)) return NextResponse.json({ error: "NotFound" }, { status: 404 });
  const headers = new Headers();
  for (const h of ["content-type", "accept", "x-standin-did", "atproto-proxy"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const up = await fetch(`${target.replace(/\/+$/, "")}/${path}${req.nextUrl.search}`, {
    method: req.method,
    headers,
    body: req.method === "POST" ? await req.arrayBuffer() : undefined,
    cache: "no-store",
  });
  return new NextResponse(await up.arrayBuffer(), {
    status: up.status,
    headers: { "content-type": up.headers.get("content-type") ?? "application/json" },
  });
}

export { forward as GET, forward as POST };
