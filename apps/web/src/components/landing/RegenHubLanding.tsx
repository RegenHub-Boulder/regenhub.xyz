import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { Building2, HandHeart, Lightbulb, Sprout, MapPin, Calendar, Mail, Zap, Ticket, Key, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MemberDirectory } from "@/components/landing/MemberDirectory";
import { ForestMascot } from "@/components/landing/ForestMascot";
import HeroInterestForm from "@/components/landing/HeroInterestForm";
import CommunityGallery from "@/components/landing/CommunityGallery";
import UpcomingEvents from "@/components/landing/UpcomingEvents";
import { PublicHeader } from "@/components/layout/PublicHeader";
import { PublicFooter } from "@/components/layout/PublicFooter";
import { HUB_ADDRESS, HUB_EMAIL, HUB_TELEGRAM } from "@/components/layout/publicNav";

export type SignedInMember = { name: string } | null;
import forestBackground from "@/assets/forest-background.jpg";
import regenHubFull from "@/assets/regenhub-full.svg";

export default function RegenHubLanding({ signedInMember }: { signedInMember?: SignedInMember }) {
  return (
    <div className="min-h-screen relative overflow-x-hidden">
      {/* Forest background */}
      <div
        className="fixed inset-0 -z-10 opacity-30"
        style={{
          backgroundImage: `url(${forestBackground.src})`,
          backgroundSize: "150% 150%",
          backgroundPosition: "center",
        }}
      />

      <PublicHeader />

      {/* Hero */}
      <section className="relative px-6 py-16 md:py-24">
        <div className="max-w-4xl mx-auto text-center">
          <div className="glass-panel-strong p-8 md:p-12 hover-lift animate-fade-in-up">
            <Image src={regenHubFull} alt="RegenHub" height={160} className="h-32 md:h-40 w-auto mx-auto mb-6" />
            <p className="text-xl md:text-2xl mb-3 text-muted max-w-2xl mx-auto leading-relaxed">
              Boulder&apos;s regenerative coworking space
            </p>
            <p className="text-base text-muted/80 mb-8 max-w-lg mx-auto">
              A cooperative workspace for builders and changemakers.
              Your first day is free.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/freeday">
                <Button className="btn-primary-glass px-8 py-3 text-lg font-semibold hover-glow gap-2">
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

      {/* Community Gallery */}
      <CommunityGallery />

      {/* What We Offer */}
      <section className="relative px-6 py-16">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">What We Offer</h2>
            <p className="text-xl text-muted max-w-2xl mx-auto">Community. Democracy. Regeneration.</p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { icon: Building2, title: "Community Infrastructure", body: "Affordable co-working and event space for regenerative builders and changemakers." },
              { icon: HandHeart, title: "Economic Democracy", body: "Meaningful ownership and governance through profit-sharing and equity." },
              { icon: Sprout, title: "Regenerative Tech Incubation", body: "Mentorship and support for climate, social equity, and sustainability projects." },
              { icon: Lightbulb, title: "Collective Intelligence", body: "Building 'scenius' \u2014 collective intelligence through sustained collaboration." },
            ].map(({ icon: Icon, title, body }) => (
              <Card key={title} className="glass-panel hover-lift">
                <CardContent className="p-6 text-center">
                  <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center rounded-full" style={{ background: "rgba(45,90,61,0.2)" }}>
                    <Icon className="w-8 h-8 text-sage" />
                  </div>
                  <h3 className="text-lg font-semibold mb-3">{title}</h3>
                  <p className="text-muted text-sm leading-relaxed">{body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* How to Co-work With Us */}
      <section className="relative px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">Co-work With Us</h2>
            <p className="text-xl text-muted max-w-3xl mx-auto">
              Start with a free day, come back with day passes, or get your own desk.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-6 mb-8">
            {[
              {
                icon: Zap,
                tier: "Free Day",
                price: "Free",
                color: "var(--sage)",
                desc: "Try the space with no commitment",
                items: ["Full day access (8 AM \u2013 6 PM)", "WiFi, coffee, and community", "One free day per person"],
              },
              {
                icon: Ticket,
                tier: "Day Pass",
                price: "$30/day",
                color: "var(--gold)",
                desc: "Come back whenever you want",
                items: ["Door code access (8 AM \u2013 6 PM)", "$25/day for members", "Monday \u2013 Friday, no contract"],
              },
              {
                icon: Key,
                tier: "Desk Membership",
                price: "from $250/mo",
                color: "var(--forest-light)",
                desc: "Full access with a permanent door code",
                items: ["Hot desk $250/mo \u00b7 cold desk $500/mo", "24/7 access", "Co-op ownership pathway"],
              },
            ].map(({ icon: Icon, tier, price, color, desc, items }) => (
              <Card key={tier} className="glass-panel hover-lift" style={{ borderLeft: `4px solid ${color}` }}>
                <CardContent className="p-6">
                  <Icon className="w-7 h-7 text-sage mb-3" />
                  <h3 className="text-lg font-semibold mb-1">{tier}</h3>
                  <p className="text-xl font-bold text-gold mb-2">{price}</p>
                  <p className="text-sm text-muted mb-3">{desc}</p>
                  <ul className="text-sm text-muted space-y-1">
                    {items.map((i) => <li key={i}>&bull; {i}</li>)}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="text-center space-y-3">
            <Link href="/freeday">
              <Button className="btn-primary-glass px-8 py-3 text-lg font-semibold hover-glow gap-2">
                Get Your Free Day
                <ArrowRight className="w-5 h-5" />
              </Button>
            </Link>
            <p className="text-sm text-muted">
              Contributing memberships start at $30/mo —{" "}
              <Link href="/membership" className="text-sage hover:underline">see all tiers →</Link>
            </p>
          </div>
        </div>
      </section>

      {/* Member Directory */}
      <section className="relative px-6 py-16">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">Our Community</h2>
            <p className="text-xl text-muted max-w-2xl mx-auto">Builders, creators, and changemakers shaping regenerative futures</p>
          </div>
          <MemberDirectory />
        </div>
      </section>

      {/* Events */}
      <section className="relative px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="glass-panel-subtle p-8 md:p-12">
            <div className="text-center mb-12">
              <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">Upcoming Events</h2>
              <p className="text-xl text-muted max-w-2xl mx-auto">Join us for community building, learning, and collaboration</p>
            </div>
            {/* regenOS collective calendar when configured, Luma embed otherwise. */}
            <Suspense fallback={<div className="h-24" />}>
              <UpcomingEvents />
            </Suspense>
          </div>
        </div>
      </section>

      {/* Location / Contact */}
      <section className="relative px-6 py-16">
        <div className="max-w-4xl mx-auto">
          <Card className="glass-panel-strong hover-lift">
            <CardContent className="p-8 md:p-12 text-center">
              <h2 className="text-3xl md:text-4xl font-bold mb-8 text-forest">Find Us in Boulder</h2>
              <div className="grid md:grid-cols-2 gap-8 mb-8">
                <div className="space-y-3">
                  <div className="flex items-center justify-center gap-2">
                    <MapPin className="w-5 h-5 text-sage" />
                    <span className="font-medium">Location</span>
                  </div>
                  <p className="text-muted">{HUB_ADDRESS}</p>
                </div>
                <div className="space-y-3">
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
            </CardContent>
          </Card>
        </div>
      </section>

      <PublicFooter />

      {/* Hopping mascot — client component */}
      <ForestMascot />
    </div>
  );
}
