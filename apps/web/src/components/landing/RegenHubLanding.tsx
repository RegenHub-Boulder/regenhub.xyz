import Link from "next/link";
import { Suspense } from "react";
import { MapPin, Calendar, Mail, Zap, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MemberDirectory } from "@/components/landing/MemberDirectory";
import HeroInterestForm from "@/components/landing/HeroInterestForm";
import CommunityGallery from "@/components/landing/CommunityGallery";
import UpcomingEvents, { NextNights } from "@/components/landing/UpcomingEvents";
import { BrushEnso } from "@/components/landing/BrushEnso";
import { PublicHeader } from "@/components/layout/PublicHeader";
import { PublicFooter } from "@/components/layout/PublicFooter";
import { HUB_ADDRESS, HUB_EMAIL, HUB_TELEGRAM } from "@/components/layout/publicNav";

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

export default function RegenHubLanding({ signedInMember }: { signedInMember?: SignedInMember }) {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <PublicHeader />

      {/* Hero: the ensō starts drawing; the title, its line and the actions settle in while it draws. */}
      <section className="px-6 pt-8 pb-6 md:pt-12">
        <div className="max-w-[40rem] mx-auto text-center">
          <BrushEnso />
          <h1
            className="arrive text-[clamp(1.75rem,4.6vw,2.4rem)] italic leading-tight mb-3 text-foreground [--arrive-at:250ms]"
          >
            Boulder&apos;s regenerative coworking space
          </h1>
          <p className="arrive text-[1.05rem] text-muted mb-8 max-w-lg mx-auto [--arrive-at:370ms] [--arrive-rise:4px]">
            A cooperative workspace for builders and changemakers.
            Your first day is free.
          </p>
          <div className="arrive [--arrive-at:470ms] [--arrive-rise:4px]">
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/freeday">
                <Button className="btn-primary-glass px-8 py-3 text-lg gap-2">
                  <Zap className="w-5 h-5" />
                  Try a Free Day
                </Button>
              </Link>
              <Link href="/events">
                <Button className="btn-glass px-8 py-3 text-lg">
                  View Events
                </Button>
              </Link>
            </div>
            {signedInMember ? (
              <p className="mt-6 text-sm text-muted">
                You&apos;re in, {signedInMember.name.split(" ")[0]}.{" "}
                <Link href="/portal" className="text-sage hover:underline">
                  Open your portal →
                </Link>
              </p>
            ) : (
              <HeroInterestForm />
            )}
          </div>
        </div>
      </section>

      {/* The regular nights lead, right under the hero */}
      <Suspense fallback={<div className="h-40" />}>
        <NextNights />
      </Suspense>

      {/* Community Gallery */}
      <CommunityGallery />

      {/* What We Offer: a two-column list, no cards */}
      <Section title="What We Offer" line="Community. Democracy. Regeneration.">
        <div className="grid sm:grid-cols-2 gap-x-10 gap-y-6">
          {[
            { title: "Community Infrastructure", body: "Affordable co-working and event space for regenerative builders and changemakers." },
            { title: "Economic Democracy", body: "Meaningful ownership and governance through profit-sharing and equity." },
            { title: "Regenerative Tech Incubation", body: "Mentorship and support for climate, social equity, and sustainability projects." },
            { title: "Collective Intelligence", body: "Building 'scenius' \u2014 collective intelligence through sustained collaboration." },
          ].map(({ title, body }) => (
            <div key={title}>
              <h3 className="text-lg font-semibold mb-1">{title}</h3>
              <p className="text-muted leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* How to Co-work With Us: the three ways in, as ruled rows */}
      <Section title="Co-work With Us" line="Start with a free day, come back with day passes, or get your own desk.">
        <ul className="mb-8 border-b border-rule">
          {[
            {
              tier: "Free Day",
              price: "Free",
              desc: "Try the space with no commitment",
              items: ["Full day access (8 AM \u2013 6 PM)", "WiFi, coffee, and community", "One free day per person"],
            },
            {
              tier: "Day Pass",
              price: "$30/day",
              desc: "Come back whenever you want",
              items: ["Door code access (8 AM \u2013 6 PM)", "$25/day for members", "Monday \u2013 Friday, no contract"],
            },
            {
              tier: "Desk Membership",
              price: "from $250/mo",
              desc: "Full access with a permanent door code",
              items: ["Hot desk $250/mo \u00b7 cold desk $500/mo", "24/7 access", "Member demos and Studio Night"],
            },
          ].map(({ tier, price, desc, items }) => (
            <li key={tier} className="border-t border-rule py-5 sm:grid sm:grid-cols-[11rem_1fr] sm:gap-6">
              <div>
                <h3 className="text-lg font-semibold">{tier}</h3>
                <p className="text-lg text-gold mb-2 sm:mb-0">{price}</p>
              </div>
              <div>
                <p className="mb-1">{desc}</p>
                <ul className="text-muted">
                  {items.map((i) => <li key={i}>{i}</li>)}
                </ul>
              </div>
            </li>
          ))}
        </ul>
        <div className="text-center space-y-3">
          <Link href="/freeday">
            <Button className="btn-primary-glass px-8 py-3 text-lg gap-2">
              Get Your Free Day
              <ArrowRight className="w-5 h-5" />
            </Button>
          </Link>
          <p className="text-muted">
            Contributing memberships start at $30/mo —{" "}
            <Link href="/membership" className="text-sage hover:underline">see all tiers →</Link>
          </p>
        </div>
      </Section>

      {/* Member Directory */}
      <Section title="Our Community" line="Builders, creators, and changemakers shaping regenerative futures">
        <MemberDirectory />
      </Section>

      {/* Events: regenOS collective calendar when configured, Luma embed otherwise. */}
      <Section title="Upcoming Events" line="Join us for community building, learning, and collaboration">
        <Suspense fallback={<div className="h-24" />}>
          <UpcomingEvents />
        </Suspense>
      </Section>

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
          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-8">
            <a href={`mailto:${HUB_EMAIL}`} className="flex items-center justify-center gap-2 hover:text-sage transition-colors">
              <Mail className="w-5 h-5" />
              {HUB_EMAIL}
            </a>
            <a href={HUB_TELEGRAM} target="_blank" rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 hover:text-sage transition-colors">
              <span>Telegram</span> Community Chat
            </a>
          </div>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/freeday">
              <Button className="btn-primary-glass px-6">Try a Free Day</Button>
            </Link>
            <Link href="/events">
              <Button className="btn-glass px-6">View All Events</Button>
            </Link>
          </div>
        </div>
      </Section>

      <PublicFooter />
    </div>
  );
}
