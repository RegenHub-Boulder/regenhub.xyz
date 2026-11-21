import Link from "next/link";
import { Suspense } from "react";
import { MapPin, Calendar, Mail, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MemberDirectory } from "@/components/landing/MemberDirectory";
import HeroInterestForm from "@/components/landing/HeroInterestForm";
import CommunityGallery from "@/components/landing/CommunityGallery";
import HomeNights from "@/components/landing/HomeNights";
import { BrushEnso } from "@/components/landing/BrushEnso";
import { PublicHeader } from "@/components/layout/PublicHeader";
import { PublicFooter } from "@/components/layout/PublicFooter";
import { HUB_ADDRESS, HUB_EMAIL, HUB_TELEGRAM } from "@/components/layout/publicNav";
import {
  DAY_PASS_MEMBER_CENTS,
  DAY_PASS_PUBLIC_CENTS,
  MEMBER_DAY_PLANS,
  MEMBERSHIP_FROM_CENTS,
  PLANS,
  coworkingDays,
  formatCents,
} from "@/lib/plans";

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
 * The home page (T-482, "what we offer now"): who we are, the next nights, membership as the main offer with
 * day passes, desks and the free day below it, the members, one line about the co-op, photos, where we are,
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
        <ul className="border-b border-rule mb-6" data-testid="home-member-plans">
          {MEMBER_DAY_PLANS.map((p) => (
            <li key={p.label} className="border-t border-rule py-3 flex items-baseline justify-between gap-4">
              <span className="text-lg">
                <span className="text-gold">{formatCents(p.defaultMonthlyCents)}</span>
                <span className="text-muted"> a month</span>
              </span>
              <span className="text-right">{coworkingDays(p.monthlyDayPasses)} a month</span>
            </li>
          ))}
        </ul>
        <p className="mb-2 font-semibold">Every plan includes</p>
        <ul className="space-y-2 text-muted mb-8 list-disc pl-5 marker:text-sage">
          <li>
            <span className="text-foreground">Member demos:</span> the Friday demos before 420 Happy Hour, and first
            claim on demo slots at Techne Tuesdays.
          </li>
          <li>
            <span className="text-foreground">Studio Night:</span> hang out with other members and get help with your
            agent, your data, your tools.
          </li>
          <li>
            <span className="text-foreground">Your member page:</span> a page of your own and a place in the member
            directory.
          </li>
          <li>
            Unused days carry over. Extra day passes are {formatCents(DAY_PASS_MEMBER_CENTS)} for members instead of{" "}
            {formatCents(DAY_PASS_PUBLIC_CENTS)}.
          </li>
        </ul>
        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link href="/apply">
            <Button className="btn-primary-glass px-8 py-3 text-lg gap-2">
              Apply to join
              <ArrowRight className="w-5 h-5" />
            </Button>
          </Link>
          <Link href="/membership" className="text-sage hover:underline">
            More about membership →
          </Link>
        </div>

        {/* The smaller ways in */}
        <h3 className="mt-12 mb-3 text-center text-lg font-semibold">Or come by the day</h3>
        <ul className="border-b border-rule text-[0.95rem]" data-testid="home-add-ons">
          {[
            {
              name: "Free day",
              price: "Free",
              note: "Your first day is on us. Pick a date and we'll send you a door code.",
              href: "/freeday",
            },
            {
              name: "Day pass",
              price: `${formatCents(DAY_PASS_PUBLIC_CENTS)} a day, ${formatCents(DAY_PASS_MEMBER_CENTS)} for members`,
              note: "Monday to Friday, 8 AM to 6 PM, no contract.",
            },
            {
              name: "Desks",
              price: `Hot desk ${formatCents(PLANS.hot_desk.defaultMonthlyCents)} · cold desk ${formatCents(PLANS.cold_desk.defaultMonthlyCents)} a month`,
              note: "A permanent door code and 24/7 access.",
              href: "/membership",
            },
          ].map(({ name, price, note, href }) => (
            <li key={name} className="border-t border-rule py-3 sm:grid sm:grid-cols-[8rem_1fr] sm:gap-6">
              <p className="font-semibold">
                {href ? (
                  <Link href={href} className="hover:text-sage transition-colors">
                    {name}
                  </Link>
                ) : (
                  name
                )}
              </p>
              <div>
                <p className="text-gold">{price}</p>
                <p className="text-muted">{note}</p>
              </div>
            </li>
          ))}
        </ul>
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
