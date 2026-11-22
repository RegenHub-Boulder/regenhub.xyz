import Link from "next/link";
import { Suspense } from "react";
import { MapPin, Calendar, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MemberDirectory } from "@/components/landing/MemberDirectory";
import HeroInterestForm from "@/components/landing/HeroInterestForm";
import CommunityGallery from "@/components/landing/CommunityGallery";
import HomeNights from "@/components/landing/HomeNights";
import { BrushEnso } from "@/components/landing/BrushEnso";
import { PublicHeader } from "@/components/layout/PublicHeader";
import { PublicFooter } from "@/components/layout/PublicFooter";
import { HUB_ADDRESS, HUB_EMAIL, HUB_TELEGRAM } from "@/components/layout/publicNav";
import { MEMBERSHIP_FROM_CENTS, formatCents } from "@/lib/plans";
import HomeMembership from "@/components/landing/HomeMembership";

export type SignedInMember = { name: string } | null;

/** The book's section opening: a short centred rule, then an italic heading and its line. */
function Section({ title, line, children, label }: { title?: string; line?: string; children: React.ReactNode; label?: string }) {
  return (
    <section className="px-6 py-10" aria-label={label}>
      <div className="mx-auto max-w-[40rem]">
        <hr className="mx-auto mb-10 w-12 border-ink/40" />
        {title && (
          <div className="text-center mb-8">
            <h2 className="text-[1.6rem] leading-tight mb-2 text-forest">{title}</h2>
            {line && <p className="text-[1.05rem] text-muted">{line}</p>}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

/**
 * The home page (T-482, "what we offer now"): who we are, the next nights, membership as one ladder from the
 * cheapest plan to a desk of your own, with the free day and day pass in one line under it, the members, one line about the co-op, photos, where we are,
 * and staying in touch. Every price comes from lib/plans.ts, as on /membership. Copy marked "draft for Aaron"
 * in the PR is new; the rest reuses /membership's and /events' words.
 */
export default function RegenHubLanding({ signedInMember }: { signedInMember?: SignedInMember }) {
  const from = formatCents(MEMBERSHIP_FROM_CENTS);
  return (
    <div className="min-h-screen overflow-x-hidden">
      <PublicHeader />

      {/* Hero: the ensō draws; the title and its line settle in once. The actions are there at once. */}
      <section className="px-6 pt-8 pb-2 md:pt-12">
        <div className="max-w-[40rem] mx-auto text-center">
          <BrushEnso />
          <h1 className="arrive text-[clamp(1.75rem,4.6vw,2.4rem)] italic leading-tight mb-3 text-foreground [--arrive-at:250ms]">
            A co-op of builders in Boulder
          </h1>
          <p className="arrive text-[1.05rem] text-muted mb-8 max-w-lg mx-auto [--arrive-at:370ms] [--arrive-rise:4px]">
            Techne Tuesdays are free and open to everyone. Members show their work and help each other with it.
            Your first day is free.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/events">
              <Button className="btn-primary-glass px-8 py-3 text-lg w-full sm:w-auto">Come to a Tuesday</Button>
            </Link>
            <Link href="/freeday">
              <Button className="btn-glass px-8 py-3 text-lg w-full sm:w-auto">Try a free day</Button>
            </Link>
          </div>
          {signedInMember && (
            <p className="mt-6 text-sm text-muted">
              You&apos;re in, {signedInMember.name.split(" ")[0]}.{" "}
              <Link href="/portal" className="text-sage hover:underline">
                Open your portal →
              </Link>
            </p>
          )}
        </div>
      </section>

      {/* The next nights, from the same calendar /events reads */}
      <Section title="Coming up">
        <Suspense
          fallback={
            <p className="text-center">
              <Link href="/events" className="text-sage hover:underline">See the nights on the events page →</Link>
            </p>
          }
        >
          <HomeNights />
        </Suspense>
      </Section>

      {/* Membership: the main offer */}
      <Section
        title={`Membership, from ${from} a month`}
        line="Membership gets you into the rooms where members show their work and help each other with it."
      >
        <HomeMembership />
      </Section>

      {/* Members */}
      <Section title="Members" line="Some of the people who work here.">
        <MemberDirectory />
      </Section>

      {/* The co-op, in one line (draft for Aaron) */}
      <Section label="About RegenHub">
        <p className="text-center text-[1.1rem] italic max-w-lg mx-auto">
          RegenHub is a cooperative workspace in downtown Boulder. Its members and stewards host the nights, and the
          open ones are open to everyone.
        </p>
      </Section>

      {/* Photos */}
      <CommunityGallery />

      {/* Location / Contact */}
      <Section>
        <div className="text-center">
          <h2 className="text-[1.6rem] leading-tight mb-8 text-forest">Find Us in Boulder</h2>
          <div className="grid sm:grid-cols-2 gap-8 mb-8">
            <div className="space-y-2">
              <div className="flex items-center justify-center gap-2">
                <MapPin className="w-5 h-5 text-sage" />
                <span className="font-medium">Location</span>
              </div>
              <p className="text-muted">{HUB_ADDRESS}</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-center gap-2">
                <Calendar className="w-5 h-5 text-sage" />
                <span className="font-medium">Access</span>
              </div>
              <p className="text-muted">Members & Day Pass Holders<br />Public Events Welcome</p>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <a href={`mailto:${HUB_EMAIL}`} className="flex items-center justify-center gap-2 hover:text-sage transition-colors">
              <Mail className="w-5 h-5" />
              {HUB_EMAIL}
            </a>
            <a href={HUB_TELEGRAM} target="_blank" rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 hover:text-sage transition-colors">
              <span>Telegram</span> Community Chat
            </a>
          </div>
        </div>
      </Section>

      {/* Stay in touch, for anyone not signed in */}
      {!signedInMember && (
        <Section title="Stay in touch" line="Leave your email and we'll write when there's something on.">
          <HeroInterestForm />
        </Section>
      )}

      <PublicFooter />
    </div>
  );
}
