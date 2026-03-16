import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import FreeDayForm from "./FreeDayForm";
import type { Metadata } from "next";

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

export default async function FreeDayPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Not authenticated — show the full landing page / signup form
    return <FreeDayForm />;
  }

  // Authenticated — check for an existing claim
  const admin = createServiceClient();

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
    return <FreeDayForm authenticatedEmail={user.email ?? undefined} />;
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const claimDate = new Date(claim.claimed_date + "T12:00:00");
    claimDate.setHours(0, 0, 0, 0);

    if (claimDate < today) {
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
        status: claim.status as "reserved" | "activated" | "expired" | "cancelled",
      }}
      existingCode={existingCode}
    />
  );
}
