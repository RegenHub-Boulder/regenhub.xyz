import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { MagicLinkWizard } from "@/components/auth/MagicLinkWizard";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";

/**
 * `/login?token=…` — the landing page for the link regenOS EMAILS.
 *
 * This URL isn't ours to choose: prod regenOS (email mode) mails
 * `<app_base_url>/login?token=…` to any address it doesn't know, and with
 * regenhub.xyz as that base the link points here. Until now this app served no
 * `/login`, so every new member's link 404'd — the majority path, since most
 * RegenHub members have no regenOS account yet. `<MagicLinkWizard>` is the
 * second half of the wizard `RegenosLoginPanel` starts.
 *
 * NOT the sign-in page — that stays `/auth/login`. Both redirect cases below
 * land there rather than showing anything: the flag being off means this
 * surface shouldn't exist at all, and a bare `/login` (someone shortening the
 * URL, a bookmark, a link with the query stripped by a mail client) has no
 * token to redeem, so the honest answer to both is "here's the front door".
 * A redirect, not a 404, because `/login` is a name people TYPE.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Finish signing in — RegenHub",
  // A single-use redemption URL should never be indexed or followed.
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function MagicLinkLoginPage({ searchParams }: PageProps) {
  if (!isRegenosLoginEnabled()) {
    redirect("/auth/login");
  }

  const { token } = await searchParams;
  if (!token) {
    redirect("/auth/login");
  }

  // Same shell as /auth/login — one card, centred, so arriving from the inbox
  // looks like the page they'd have reached by hand.
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="glass-panel-strong p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-forest mb-2">Almost there</h1>
            {/* Neutral on purpose: the wizard below hasn't redeemed the token yet,
                so this header can't claim the email is confirmed. */}
            <p className="text-muted text-sm">
              One more step — pick a name and we&apos;ll finish setting up your account.
            </p>
          </div>
          <MagicLinkWizard token={token} />
        </div>
      </div>
    </div>
  );
}
