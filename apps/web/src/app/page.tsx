import type { Metadata } from "next";
import { OG_IMAGES } from "@/lib/metadata";
import { MEMBERSHIP_FROM_CENTS, formatCents } from "@/lib/plans";
import { createClient } from "@/lib/supabase/server";
import RegenHubLanding, { type SignedInMember } from "@/components/landing/RegenHubLanding";

const SHARE_LINE = `A co-op of builders in Boulder. Techne Tuesdays are open to everyone; membership from ${formatCents(MEMBERSHIP_FROM_CENTS)} a month.`;

export const metadata: Metadata = {
  title: "RegenHub Boulder — a co-op of builders",
  description: `${SHARE_LINE} Your first day is free.`,
  keywords: ["coworking", "Boulder", "cooperative", "Techne Tuesdays", "community", "events"],
  openGraph: {
    title: "RegenHub Boulder",
    description: SHARE_LINE,
    url: "https://regenhub.xyz",
    siteName: "RegenHub Boulder",
    type: "website",
    locale: "en_US",
    images: OG_IMAGES,
  },
  twitter: {
    card: "summary_large_image",
    title: "RegenHub Boulder",
    description: SHARE_LINE,
    images: OG_IMAGES,
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
