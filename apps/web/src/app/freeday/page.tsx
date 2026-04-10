import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import FreeDayForm from "./FreeDayForm";
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle, ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "Try RegenHub Free for a Day — Boulder Coworking",
  description:
    "Experience Boulder's regenerative coworking space with a free day pass. No commitment, just show up and see if RegenHub is right for you.",
  openGraph: {
    title: "Free Day at RegenHub Boulder",
    description:
      "Try Boulder's regenerative coworking space for free. Get a door code and come work with us for a day.",
    url: "https://regenhub.xyz/freeday",
  },
};

export default async function FreeDayPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const { ref } = await searchParams;

  const admin = createServiceClient();

  // Look up inviter if ref code is present
  let inviter: { name: string; invite_code: string } | undefined;
  if (ref) {
    const { data: inviterData } = await admin
      .from("members")
      .select("name, invite_code, is_coop_member")
      .eq("invite_code", ref.toUpperCase())
      .single();

    if (inviterData?.is_coop_member && inviterData.invite_code) {
      inviter = {
        name: inviterData.name,
        invite_code: inviterData.invite_code,
      };
    }
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Not authenticated — show the full landing page / signup form
    return <FreeDayForm inviter={inviter} />;
  }

  // Check if user is already a full member (cold_desk/hot_desk/hub_friend)
  const { data: existingMember } = await admin
    .from("members")
    .select("id, member_type")
    .eq("supabase_user_id", user.id)
    .single();

  if (
    existingMember &&
    existingMember.member_type !== "day_pass"
  ) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <Card className="glass-panel-strong max-w-md w-full">
          <CardContent className="p-10 text-center">
            <CheckCircle className="w-12 h-12 text-sage mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-forest mb-3">
              You&apos;re Already a Member!
            </h1>
            <p className="text-muted mb-6">
              No need for a free day pass — you have full access to RegenHub.
            </p>
            <Link href="/portal">
              <Button className="btn-primary-glass gap-2">
                Go to Your Portal
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Authenticated — check for an existing claim
  // Try by supabase_user_id first
  let { data: claim } = await admin
    .from("free_day_claims")
    .select("*")
    .eq("supabase_user_id", user.id)
    .single();

  // Auto-link by email if no claim found by user_id
  if (!claim && user.email) {
    const { data: emailClaim } = await admin
      .from("free_day_claims")
      .select("*")
      .eq("email", user.email)
      .is("supabase_user_id", null)
      .single();

    if (emailClaim) {
      await admin
        .from("free_day_claims")
        .update({ supabase_user_id: user.id })
        .eq("id", emailClaim.id);
      claim = { ...emailClaim, supabase_user_id: user.id };
    }
  }

  if (!claim) {
    // Authenticated but no claim — show the date picker form with email locked
    return (
      <FreeDayForm
        authenticatedEmail={user.email ?? undefined}
        inviter={inviter}
      />
    );
  }

  // If activated, fetch the existing door code
  let existingCode: { code: string; expires_at: string | null } | undefined;
  if (claim.status === "activated" && claim.day_code_id) {
    const { data: codeData } = await admin
      .from("day_codes")
      .select("code, expires_at")
      .eq("id", claim.day_code_id)
      .single();

    if (codeData) {
      existingCode = {
        code: codeData.code,
        expires_at: codeData.expires_at,
      };
    }
  }

  // Check if a reserved claim's date has passed — mark as expired
  if (claim.status === "reserved") {
    // Compare in Mountain Time to match the rest of the system
    const todayMT = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Denver",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()); // YYYY-MM-DD

    if (claim.claimed_date < todayMT) {
      await admin
        .from("free_day_claims")
        .update({ status: "expired" })
        .eq("id", claim.id);
      claim = { ...claim, status: "expired" };
    }
  }

  return (
    <FreeDayForm
      claim={{
        id: claim.id,
        email: claim.email,
        name: claim.name,
        claimed_date: claim.claimed_date,
        day_code_id: claim.day_code_id,
        status: claim.status as "pending" | "reserved" | "activated" | "expired" | "cancelled",
      }}
      existingCode={existingCode}
    />
  );
}
