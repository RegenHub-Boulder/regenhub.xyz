import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { ALREADY_MEMBER, codeStillWorks, findClaim, isAlreadyMember } from "@/lib/freeDayClaim";
import FreeDayForm from "./FreeDayForm";
import type { Metadata } from "next";
import { OG_IMAGES } from "@/lib/metadata";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle, ArrowRight } from "lucide-react";
import { plannedDay, usuallyHere } from "@/lib/firstVisit";
import { boulderToday, planDays, plannedDayWords } from "@regenhub/shared";
import type { FirstVisitInfo } from "@/components/freeday/FirstVisitGuide";

export const metadata: Metadata = {
  title: "Try RegenHub Free for a Day — Boulder Coworking",
  description:
    "Experience Boulder's regenerative coworking space with a free day pass. No commitment, just show up and see if RegenHub is right for you.",
  openGraph: {
    title: "Free Day at RegenHub Boulder",
    description:
      "Try Boulder's regenerative coworking space for free. Get a door code and come work with us for a day.",
    url: "https://regenhub.xyz/freeday",
    images: OG_IMAGES,
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

  // Already a member (lib/memberStanding.ts: a desk or hub friend, or a $30+ plan): no free day needed.
  if (await isAlreadyMember(admin, user.email ?? "", user.id)) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-6">
        <Card className="glass-panel-strong max-w-md w-full">
          <CardContent className="p-10 text-center" data-testid="freeday-already-member">
            <CheckCircle className="w-12 h-12 text-sage mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-forest mb-3">
              You&apos;re already a member
            </h1>
            <p className="text-muted mb-6">{ALREADY_MEMBER}</p>
            <Link href="/portal">
              <Button className="btn-primary-glass gap-2">
                Go to your portal
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const claim = await findClaim(admin, user);

  // No claim, or a lapsed one (approved, never used within FREE_DAY_LAPSE_DAYS): the form, email locked.
  if (!claim || claim.status === "expired") {
    return (
      <FreeDayForm
        authenticatedEmail={user.email ?? undefined}
        inviter={inviter}
        lapsed={claim?.status === "expired"}
      />
    );
  }

  // Used: the code back while it still works (the same day); after that, the page says the free day is used.
  let existingCode: { code: string; expires_at: string | null } | undefined;
  if (claim.status === "activated" && claim.day_code_id) {
    const { data: codeData } = await admin
      .from("day_codes")
      .select("code, expires_at, is_active")
      .eq("id", claim.day_code_id)
      .maybeSingle();

    if (codeData && codeStillWorks(codeData)) {
      existingCode = {
        code: codeData.code,
        expires_at: codeData.expires_at,
      };
    }
  }

  // Approved, or the code out today: what to expect (who's usually in, the day they said they're coming).
  let firstVisit: FirstVisitInfo | undefined;
  if (claim.status === "reserved" || existingCode) {
    const [line, planned] = await Promise.all([usuallyHere(admin), plannedDay(admin, claim.id)]);
    firstVisit = {
      usuallyHere: line,
      days: planDays(),
      // A day already past is forgotten here: they can say a new one.
      planned: planned && planned >= boulderToday().date ? { date: planned, words: plannedDayWords(planned) } : null,
    };
  }

  return (
    <FreeDayForm
      firstVisit={firstVisit}
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
