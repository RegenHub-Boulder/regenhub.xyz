import type { Metadata } from "next";
import { OG_IMAGES } from "@/lib/metadata";
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
    images: OG_IMAGES,
  },
  twitter: {
    card: "summary_large_image",
    title: "RegenHub Boulder",
    description: "A regenerative innovation hub in Boulder, CO. Community. Democracy. Regeneration.",
    images: OG_IMAGES,
  },
};

// Homepage v2 prototype ("Co-op broadsheet"). Default OFF; NEXT_PUBLIC_HOME_V2=true
// is baked at build time like every NEXT_PUBLIC_* var.
const HOME_V2 = ["true", "1", "yes"].includes((process.env.NEXT_PUBLIC_HOME_V2 ?? "").toLowerCase());

export default async function Home() {
  if (HOME_V2) {
    const { default: HomeV2 } = await import("@/components/landing/v2/HomeV2");
    return <HomeV2 />;
  }
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
