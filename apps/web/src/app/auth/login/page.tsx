import { LoginForm } from "@/components/auth/LoginForm";
import { RegenosLoginPanel } from "@/components/auth/RegenosLoginPanel";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";

export const metadata = { title: "Sign In — RegenHub" };

const ERROR_MESSAGES: Record<string, string> = {
  auth_error:
    "That sign-in link didn't work — it may have expired or been used already. Enter your email below to get a fresh one.",
  expired:
    "Your sign-in link expired. Enter your email and we'll send you another.",
};

interface PageProps {
  searchParams: Promise<{ error?: string; next?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const banner = params.error ? (ERROR_MESSAGES[params.error] ?? null) : null;
  // Only honor next params that look like internal paths to avoid open redirects.
  const safeNext = params.next && /^\/[a-zA-Z0-9_\-/?=&]*$/.test(params.next) ? params.next : undefined;

  // Phase 2 one-login, default OFF. When off this page is byte-identical to
  // what it has always been: the Supabase one-time-link form and nothing else.
  const regenosEnabled = isRegenosLoginEnabled();

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="glass-panel-strong p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-forest mb-2">Member Portal</h1>
            <p className="text-muted text-sm">
              {regenosEnabled
                ? "Sign in with your membership email. Check your inbox (and spam folder, just in case)."
                : "Enter your email — we'll send a one-time sign-in link. Check your inbox (and spam folder, just in case)."}
            </p>
          </div>

          {regenosEnabled && (
            <>
              <RegenosLoginPanel next={safeNext} />
              {/* The classic lane stays available for the whole transition —
                  a regenOS outage must never lock a member out of their door. */}
              <div className="flex items-center gap-3 my-6">
                <div className="h-px flex-1 bg-white/15" />
                <span className="text-xs text-muted uppercase tracking-wider">or</span>
                <div className="h-px flex-1 bg-white/15" />
              </div>
            </>
          )}

          <LoginForm initialBanner={banner} next={safeNext} />
        </div>
      </div>
    </div>
  );
}
