"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

interface Props {
  /** Banner to show above the form — used to surface ?error=… from the auth callback. */
  initialBanner?: string | null;
  /** Optional post-login destination (e.g. "/apply"). Defaults to /portal. */
  next?: string;
}

export function LoginForm({ initialBanner = null, next = "/portal" }: Props = {}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(initialBanner);

  const sendLink = async (isResend: boolean) => {
    setLoading(true);
    setError(null);
    setResent(false);

    try {
      const supabase = createClient();
      const callbackUrl = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: callbackUrl,
        },
      });

      if (error) {
        setError(error.message);
      } else {
        setSent(true);
        setResent(isResend);
      }
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendLink(false);
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.verifyOtp({
        email,
        token: otp,
        type: "email",
      });

      if (error) {
        setError(error.message);
      } else {
        router.push(next);
        return; // keep the spinner while navigating
      }
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setLoading(false);
  };

  if (sent) {
    return (
      <div className="space-y-6">
        <div className="text-center space-y-2">
          <div className="text-4xl">📬</div>
          <h2 className="text-xl font-semibold">Check your email</h2>
          <p className="text-muted text-sm">
            We sent a link and 6-digit code to <strong>{email}</strong>.
          </p>
        </div>
        <form onSubmit={handleOtpSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="otp">Enter code</Label>
            <Input
              id="otp"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              className="bg-white/10 border-white/20 text-foreground placeholder:text-muted text-center text-lg tracking-widest"
              autoFocus
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <Button type="submit" disabled={loading || otp.length !== 6} className="btn-primary-glass w-full">
            {loading ? "Verifying…" : "Sign in"}
          </Button>
        </form>
        {resent && <p className="text-center text-xs text-sage">A new link and code are on their way.</p>}
        <p className="text-center text-xs text-muted">
          Or click the magic link in the email instead.
        </p>
        <div className="flex items-center justify-center gap-4 text-xs">
          <button
            type="button"
            disabled={loading}
            onClick={() => sendLink(true)}
            className="underline text-muted hover:text-sage transition-colors disabled:opacity-50"
          >
            Resend email
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setSent(false);
              setOtp("");
              setError(null);
              setResent(false);
            }}
            className="underline text-muted hover:text-sage transition-colors disabled:opacity-50"
          >
            Use a different email
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          className="bg-white/10 border-white/20 text-foreground placeholder:text-muted"
        />
      </div>
      {error && <p className="text-red-400 text-sm">{error}</p>}
      <Button type="submit" disabled={loading} className="btn-primary-glass w-full">
        {loading ? "Sending…" : "Send Magic Link"}
      </Button>
      <p className="text-center text-xs text-muted">
        New here?{" "}
        <a href="/freeday" className="underline hover:text-sage transition-colors">
          Try a free day
        </a>{" "}
        to get started.
      </p>
    </form>
  );
}
