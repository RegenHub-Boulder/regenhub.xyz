import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import RegenHubLanding, { type SignedInMember } from "@/components/landing/RegenHubLanding";

export const metadata: Metadata = {
  title: "RegenHub Boulder — Regenerative Coworking & Innovation Hub",
  description:
    "A cooperative coworking space in Boulder, CO building economic democracy and regenerative livelihoods. Apply for membership, attend events, and join our community of builders and changemakers.",
  keywords: ["coworking", "Boulder", "cooperative", "regenerative", "innovation hub", "community"],
  openGraph: {
    title: "RegenHub Boulder",
    description: "A regenerative innovation hub in Boulder, CO. Community. Democracy. Regeneration.",
    url: "https://regenhub.xyz",
    siteName: "RegenHub Boulder",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "RegenHub Boulder",
    description: "A regenerative innovation hub in Boulder, CO. Community. Democracy. Regeneration.",
  },
};

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let signedInMember: SignedInMember = null;
  if (user) {
    const { data: member } = await supabase
      .from("members")
      .select("name")
      .eq("supabase_user_id", user.id)
      .maybeSingle();
    if (member) signedInMember = { name: member.name };
  }

  return <RegenHubLanding signedInMember={signedInMember} />;
}
