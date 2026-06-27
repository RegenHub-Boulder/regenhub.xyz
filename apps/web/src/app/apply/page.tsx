import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { LoginForm } from "@/components/auth/LoginForm";
import ApplyForm from "./ApplyForm";
import regenHubFull from "@/assets/regenhub-full.svg";

export const metadata: Metadata = {
  title: "Apply for Membership — RegenHub",
  description:
    "Apply to join RegenHub Boulder. Tell us about you and which membership tier fits — we'll review and reach out.",
};

export default async function ApplyPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Applications require sign-in so they link to the applicant's account
  // immediately (email + supabase_user_id) — no parallel identity, and existing
  // free-day/member folks upgrade against their real record. The magic link
  // creates an account for brand-new people too, then returns them here.
  if (!user) {
    return (
      <div className="min-h-screen px-6 py-12">
        <div className="max-w-md mx-auto space-y-8">
          <div className="text-center">
            <Link href="/">
              <Image src={regenHubFull} alt="RegenHub" height={80} className="h-20 w-auto mx-auto mb-6 hover:opacity-80 transition-opacity" />
            </Link>
            <h1 className="text-3xl md:text-4xl font-bold text-forest mb-3">Apply for Membership</h1>
            <p className="text-muted max-w-sm mx-auto">
              Sign in first so your application links to your account. We&apos;ll
              email you a magic link and bring you right back here.
            </p>
          </div>

          <Card className="glass-panel">
            <CardContent className="p-8">
              <LoginForm next="/apply" />
            </CardContent>
          </Card>

          <p className="text-center text-xs text-muted">
            Want to try it first?{" "}
            <Link href="/freeday" className="text-sage hover:underline">
              Claim a free day visit →
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <ApplyForm authenticatedEmail={user.email!} />
      <div className="px-6 pb-12 -mt-4">
        <p className="text-center text-xs text-muted max-w-md mx-auto">
          Want to try it first?{" "}
          <Link href="/freeday" className="text-sage hover:underline">
            Claim a free day visit →
          </Link>
        </p>
      </div>
    </>
  );
}
