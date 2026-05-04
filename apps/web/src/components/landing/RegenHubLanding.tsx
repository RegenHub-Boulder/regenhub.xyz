import Image from "next/image";
import Link from "next/link";
import { Building2, HandHeart, Lightbulb, Sprout, MapPin, Calendar, Mail, Zap, Ticket, Key, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MemberDirectory } from "@/components/landing/MemberDirectory";
import { ForestMascot } from "@/components/landing/ForestMascot";
import HeroInterestForm from "@/components/landing/HeroInterestForm";

export type SignedInMember = { name: string } | null;
import forestBackground from "@/assets/forest-background.jpg";
import regenHubLogo from "@/assets/regenhub-logo.svg";
import regenHubText from "@/assets/regenhub-text.svg";
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

      {/* Header */}
      <header className="relative z-50 px-6 py-4">
        <nav className="glass-panel-subtle max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Image src={regenHubLogo} alt="RegenHub" width={32} height={32} className="animate-sway" />
            <Image src={regenHubText} alt="RegenHub" height={32} className="h-8 w-auto" />
          </div>
          <div className="flex items-center gap-4">
            <p className="text-sm text-muted hidden sm:block">Boulder&apos;s Regenerative Workspace</p>
            <Link href="/portal">
              <Button size="sm" className="btn-glass">Member Portal</Button>
            </Link>
          </div>
        </nav>
      </header>

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
              <a href="https://lu.ma/regenhub" target="_blank" rel="noopener noreferrer">
                <Button className="btn-glass px-8 py-3 text-lg">
                  View Events
                </Button>
              </a>
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
                price: "$25/day",
                color: "var(--gold)",
                desc: "Come back whenever you want",
                items: ["Door code access (8 AM \u2013 6 PM)", "5-pack available ($100)", "Monday \u2013 Friday, no contract"],
              },
              {
                icon: Key,
                tier: "Desk Membership",
                price: "$250/mo",
                color: "var(--forest-light)",
                desc: "Your own desk and 24/7 access",
                items: ["Permanent door code", "Hot desk or cold desk options", "Co-op ownership pathway"],
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
          <div className="text-center">
            <Link href="/freeday">
              <Button className="btn-primary-glass px-8 py-3 text-lg font-semibold hover-glow gap-2">
                Get Your Free Day
                <ArrowRight className="w-5 h-5" />
              </Button>
            </Link>
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
            <div className="glass-panel-subtle rounded-lg overflow-hidden">
              <div className="relative w-full" style={{ paddingBottom: "75%" }}>
                <iframe
                  src="https://lu.ma/embed/calendar/cal-ZCWMKx1NMCXGd7v/events?lt=dark"
                  className="absolute top-0 left-0 w-full h-full"
                  frameBorder="0"
                  allowFullScreen
                />
              </div>
            </div>
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
                  <p className="text-muted">Boulder, Colorado</p>
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
                <a href="mailto:boulder.regenhub@gmail.com" className="flex items-center justify-center gap-2 hover:text-sage transition-colors">
                  <Mail className="w-5 h-5" />
                  boulder.regenhub@gmail.com
                </a>
                <a href="https://t.me/+Mg1PLuT9pX9mMGVh" target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 hover:text-sage transition-colors">
                  <span>Telegram</span> Community Chat
                </a>
              </div>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link href="/freeday">
                  <Button className="btn-primary-glass px-6">Try a Free Day</Button>
                </Link>
                <a href="https://lu.ma/regenhub" target="_blank" rel="noopener noreferrer">
                  <Button className="btn-glass px-6">View All Events</Button>
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative px-6 py-12 mt-16">
        <div className="max-w-4xl mx-auto">
          <div className="glass-panel p-8 text-center">
            <div className="flex items-center justify-center gap-2 mb-4">
              <Image src={regenHubLogo} alt="RegenHub" width={32} height={32} className="animate-sway" />
              <Image src={regenHubText} alt="RegenHub" height={32} className="h-8 w-auto" />
            </div>
            <p className="text-lg font-medium mb-2">Building economic democracy and regenerative livelihoods</p>
            <div className="text-sm text-muted space-y-1 mb-6">
              <p>&copy; 2026 RegenHub Limited Cooperative Association</p>
              <p>A Colorado Public Benefit Corporation</p>
            </div>
            <div className="flex justify-center gap-4 flex-wrap">
              {[
                { label: "Telegram", href: "https://t.me/+Mg1PLuT9pX9mMGVh", external: true },
                { label: "Email", href: "mailto:boulder.regenhub@gmail.com", external: false },
                { label: "Free Day", href: "/freeday", external: false },
                { label: "Stay in Touch", href: "/interest", external: false },
                { label: "Events", href: "https://lu.ma/regenhub", external: true },
                { label: "Portal", href: "/portal", external: false },
              ].map(({ label, href, external }) => (
                <Button key={label} variant="ghost" size="sm" className="btn-glass" asChild>
                  {external ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
                  ) : (
                    <Link href={href}>{label}</Link>
                  )}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </footer>

      {/* Hopping mascot — client component */}
      <ForestMascot />
    </div>
  );
}
