import { LoginForm } from "@/components/auth/LoginForm";

export const metadata = { title: "Sign In — RegenHub" };

const ERROR_MESSAGES: Record<string, string> = {
  auth_error:
    "That sign-in link didn't work — it may have expired or been used already. Enter your email below to get a fresh one.",
  expired:
    "Your sign-in link expired. Enter your email and we'll send you another.",
};

interface PageProps {
  searchParams: Promise<{ error?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const banner = params.error ? (ERROR_MESSAGES[params.error] ?? null) : null;

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="glass-panel-strong p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-forest mb-2">Member Portal</h1>
            <p className="text-muted text-sm">
              Enter your email — we&apos;ll send a one-time sign-in link. Check your inbox (and spam folder, just in case).
            </p>
          </div>
          <LoginForm initialBanner={banner} />
        </div>
      </div>
    </div>
  );
}
