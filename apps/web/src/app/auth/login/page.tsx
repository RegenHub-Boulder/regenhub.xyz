import { LoginForm } from "@/components/auth/LoginForm";
import { TechneDoor } from "@/components/auth/TechneDoor";
import { DEFAULT_NEXT, safeNextPath } from "@/lib/safeNext";
import { techneConfig } from "@/lib/techne/config";

export const metadata = { title: "Sign In — RegenHub" };
export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  auth_error:
    "That sign-in link didn't work — it may have expired or been used already. Enter your email below to get a fresh one.",
  expired:
    "Your sign-in link expired. Enter your email and we'll send you another.",
};

interface PageProps {
  searchParams: Promise<{ error?: string; next?: string; signed_out?: string }>;
}

/**
 * The site's sign-in page. With the Techne door on (TECHNE_SIGNIN_ENABLED): "Sign in with Techne", one button
 * that also opens the portal for a member (components/auth/TechneDoor.tsx), with the email link as a quiet
 * fallback. With it off: the email link form, as before. The old regenOS lane is not offered here any more.
 */
export default async function LoginPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const banner = params.error ? (ERROR_MESSAGES[params.error] ?? null) : null;
  // Only honor same-origin relative paths (no open redirects).
  const safeNext = safeNextPath(params.next);
  const config = techneConfig();

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6">
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
            <TechneDoor
              config={config}
              next={safeNext ?? DEFAULT_NEXT}
              banner={banner}
              signedOut={params.signed_out === "1"}
            />
          ) : (
            <LoginForm initialBanner={banner} next={safeNext} />
          )}
        </div>
      </div>
    </div>
  );
}
