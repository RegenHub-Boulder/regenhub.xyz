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

  // If signed in, the form posts via /api/portal/application (linked to their auth user).
  // Otherwise it goes through the public /api/apply route + magic-link email.
  return (
    <>
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
