import { NextResponse } from "next/server";
import { DEFAULT_NEXT, safeNextPath } from "@/lib/safeNext";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  // An unchecked next in `${origin}${next}` is an open redirect, so validate
  // it as a same-origin path.
  const next = safeNextPath(searchParams.get("next")) ?? DEFAULT_NEXT;

  // Derive the correct public origin — behind Cloudflare/Traefik the
  // internal request.url has host 0.0.0.0:PORT, so prefer forwarded headers.
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  const origin = forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : process.env.NEXT_PUBLIC_SITE_URL ?? "https://site.regenhub.build";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/auth/login?error=auth_error`);
}
