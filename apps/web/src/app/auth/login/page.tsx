import { LoginForm } from "@/components/auth/LoginForm";
import { TechneDoor } from "@/components/auth/TechneDoor";
import { DEFAULT_NEXT, safeNextPath } from "@/lib/safeNext";
import { techneConfig } from "@/lib/techne/config";
import { createClient } from "@/lib/supabase/server";
import { currentTechne } from "@/lib/techne/webSession";
import { redirect } from "next/navigation";

export const metadata = { title: "Sign In — RegenHub" };
export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  auth_error:
    "That sign-in link didn't work — it may have expired or been used already. Enter your email below to get a fresh one.",
  expired:
    "Your sign-in link expired. Enter your email and we'll send you another.",
};

const TECHNE_ERRORS: Record<string, string> = {
  techne: "Sign-in with Techne didn't finish. Try again.",
  techne_start: "Couldn't reach Techne to start sign-in. Try again in a moment, or use an email link.",
  techne_busy: "That's a lot of sign-ins from here. Try again in an hour, or use an email link.",
  techne_portal:
    "You're signed in with Techne, but your portal couldn't open just now. Use an email link instead, or email us if it keeps happening.",
};

interface PageProps {
  searchParams: Promise<{ error?: string; next?: string }>;
}

/**
 * The site's sign-in page. With the Techne door on (TECHNE_SIGNIN_ENABLED): "Sign in with Techne", one button
 * that also opens the portal for a member (components/auth/TechneDoor.tsx), with the email link as a quiet
 * fallback. With it off: the email link form, as before. The old regenOS lane is not offered here any more.
 * Signed in to the portal and to Techne already: straight on to `next`.
 */
export default async function LoginPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const banner = params.error ? (ERROR_MESSAGES[params.error] ?? null) : null;
  // Only honor same-origin relative paths (no open redirects).
  const safeNext = safeNextPath(params.next);
  const config = techneConfig();
  const techneError = params.error ? (TECHNE_ERRORS[params.error] ?? null) : null;
  if (config && !techneError) {
    const {
      data: { user },
    } = await (await createClient()).auth.getUser();
    if (user && (await currentTechne())) redirect(safeNext ?? DEFAULT_NEXT);
  }

  return (
    <div className="py-8 sm:min-h-[60vh] flex items-start sm:items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="glass-panel-strong p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-forest mb-2">Sign in</h1>
            <p className="text-muted text-sm">
              {config
                ? "One Techne account for events and your member portal."
                : "Enter your email — we'll send a one-time sign-in link. Check your inbox (and spam folder, just in case)."}
            </p>
          </div>

          {config ? (
            <TechneDoor next={safeNext ?? DEFAULT_NEXT} banner={banner} techneError={techneError} />
          ) : (
            <LoginForm initialBanner={banner} next={safeNext} />
          )}
        </div>
      </div>
    </div>
  );
}
