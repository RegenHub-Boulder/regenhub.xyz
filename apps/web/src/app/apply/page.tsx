import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import ApplyForm from "./ApplyForm";

export const metadata: Metadata = {
  title: "Apply for Membership — RegenHub",
  description:
    "Apply to join RegenHub Boulder. Tell us about you and which membership tier fits — we'll review and reach out.",
};

export default async function ApplyPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <>
      {/* Sign-in nudge for anonymous applicants who may already have an
          account from a free-day signup. Signing in pre-fills the email
          field below and prevents creating a parallel auth identity. */}
      {!user && (
        <div className="px-6 pt-6">
          <div className="glass-panel-subtle max-w-2xl mx-auto p-4 border border-sage/20">
            <p className="text-sm text-foreground text-center">
              <span className="text-muted">Already signed up for a free day before?</span>{" "}
              <Link href="/auth/login?next=/apply" className="text-sage hover:underline font-medium">
                Sign in
              </Link>{" "}
              <span className="text-muted">to pre-fill this form.</span>
            </p>
          </div>
        </div>
      )}

      <ApplyForm authenticatedEmail={user?.email} />
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
