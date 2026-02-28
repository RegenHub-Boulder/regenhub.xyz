"use client";

import React, { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { Building2, HandHeart, Lightbulb, Sprout, MapPin, Calendar, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import forestBackground from "@/assets/forest-background.jpg";
import forestMascot from "@/assets/forest-mascot.png";
import regenHubLogo from "@/assets/regenhub-logo.svg";
import regenHubText from "@/assets/regenhub-text.svg";
import regenHubFull from "@/assets/regenhub-full.svg";

const MASCOT_SAYINGS = [
  "Scenius emerges! 🌿",
  "Collective genius activated! ✨",
  "1 + 1 = 11 here! 🚀",
  "We build the future together! 💚",
  "Ideas compound daily! 🧠",
  "Innovation through cooperation! 🤝",
  "Regenerating community wealth! 🌱",
  "Aligned action creates magic! ⚡",
  "Your potential amplified! 🎯",
  "Together we go far! 🌍",
];

export default function RegenHubLanding() {
  const [mascotX, setMascotX] = useState(-200);
  const [mascotDir, setMascotDir] = useState(1);
  const [mascotClicks, setMascotClicks] = useState(0);
  const [scrollOpacity, setScrollOpacity] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      setMascotX((x) => {
        const w = window.innerWidth;
        const nx = x + 2 * mascotDir;
        if (nx > w) return -200;
        if (nx < -200) return w;
        return nx;
      });
    }, 50);
    return () => clearInterval(id);
  }, [mascotDir]);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      if (y <= 50) setScrollOpacity(1);
      else if (y >= 300) setScrollOpacity(0);
      else setScrollOpacity(1 - (y - 50) / 250);
    };
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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
            <p className="text-sm text-muted hidden sm:block">Boulder's Regenerative Workspace</p>
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
            <p className="text-xl md:text-2xl mb-8 text-muted max-w-2xl mx-auto leading-relaxed">
              A regenerative innovation hub in Boulder, CO
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <a href="https://airtable.com/appccpfHK9zFWYR6g/shrAGo58nsstawTjQ" target="_blank" rel="noopener noreferrer">
                <Button className="btn-primary-glass px-8 py-3 text-lg font-semibold hover-glow">
                  Apply for Membership
                </Button>
              </a>
              <a href="https://luma.com/regenhub" target="_blank" rel="noopener noreferrer">
                <Button className="btn-glass px-8 py-3 text-lg">
                  View Events
                </Button>
              </a>
            </div>
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
              { icon: Lightbulb, title: "Collective Intelligence", body: "Building 'scenius' — collective intelligence through sustained collaboration." },
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

      {/* Membership Tiers */}
      <section className="relative px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">Become Part of the Cooperative</h2>
            <p className="text-xl text-muted max-w-3xl mx-auto">
              Tiered membership with participation-based governance and economic sharing.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-6 mb-8">
            {[
              { tier: "Community Members", color: "var(--sage)", items: ["Event access", "Resource library", "Community network"] },
              { tier: "Co-working Members", color: "var(--gold)", items: ["Co-working access", "Shared benefits", "Project collaboration"] },
              { tier: "Cooperative Members", color: "var(--forest-light)", items: ["Full ownership rights", "Governance participation", "Equity distribution"] },
            ].map(({ tier, color, items }) => (
              <Card key={tier} className="glass-panel hover-lift" style={{ borderLeft: `4px solid ${color}` }}>
                <CardContent className="p-6">
                  <h3 className="text-lg font-semibold mb-3">{tier}</h3>
                  <ul className="text-sm text-muted space-y-1">
                    {items.map((i) => <li key={i}>• {i}</li>)}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="text-center">
            <a href="https://airtable.com/appccpfHK9zFWYR6g/shrAGo58nsstawTjQ" target="_blank" rel="noopener noreferrer">
              <Button className="btn-primary-glass px-8 py-3 text-lg font-semibold hover-glow">
                Apply for Membership
              </Button>
            </a>
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
          <div className="glass-panel p-8 md:p-12">
            <iframe
              src="https://airtable.com/embed/appccpfHK9zFWYR6g/shr3xghNk7BTrKhRR?backgroundColor=transparent&viewControls=on"
              className="w-full min-h-[600px] rounded-lg"
              frameBorder="0"
            />
          </div>
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
                  src="https://luma.com/embed/calendar/cal-ZCWMKx1NMCXGd7v/events?lt=light"
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
              <div className="glass-panel-subtle p-6 mb-8">
                <h3 className="text-lg font-semibold mb-3">Important Note</h3>
                <p className="text-muted mb-2">
                  RegenHub Boulder is an <strong>invite-only space</strong>. You're welcome to attend our public events
                  and inquire about membership and day passes in our community channels.
                </p>
              </div>
              <div className="grid md:grid-cols-2 gap-8 mb-8">
                <div className="space-y-3">
                  <div className="flex items-center justify-center gap-2">
                    <MapPin className="w-5 h-5 text-sage" />
                    <span className="font-medium">Location</span>
                  </div>
                  <p className="text-muted">Downtown Boulder, Colorado</p>
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
                  <span>📱</span> Community Telegram
                </a>
              </div>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <a href="https://airtable.com/appccpfHK9zFWYR6g/shrAGo58nsstawTjQ" target="_blank" rel="noopener noreferrer">
                  <Button className="btn-primary-glass px-6">Apply for Membership</Button>
                </a>
                <a href="https://luma.com/regenhub" target="_blank" rel="noopener noreferrer">
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
              <p>© 2025 RegenHub Limited Cooperative Association</p>
              <p>A Colorado Public Benefit Corporation</p>
            </div>
            <div className="flex justify-center gap-4 flex-wrap">
              {[
                { label: "Telegram", href: "https://t.me/+Mg1PLuT9pX9mMGVh", external: true },
                { label: "Email", href: "mailto:boulder.regenhub@gmail.com", external: false },
                { label: "Apply", href: "https://airtable.com/appccpfHK9zFWYR6g/shrAGo58nsstawTjQ", external: true },
                { label: "Events", href: "https://luma.com/regenhub", external: true },
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

      {/* Hopping mascot */}
      {typeof window !== "undefined" && (
        <div
          className="fixed hidden lg:block z-50 cursor-pointer"
          style={{
            left: `${mascotX}px`,
            bottom: "60px",
            transform: `scaleX(${mascotDir})`,
            opacity: scrollOpacity,
            pointerEvents: scrollOpacity === 0 ? "none" : "auto",
            transition: "opacity 0.3s",
          }}
          onClick={() => {
            setMascotDir((d) => d * -1);
            setMascotClicks((c) => c + 1);
          }}
        >
          <Image src={forestMascot} alt="RegenHub Mascot" width={128} height={128} className="animate-hop opacity-80 hover:opacity-100 hover:scale-110 transition-all duration-300" />
          {mascotClicks > 0 && (
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-white/90 px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap shadow-lg text-forest">
              {MASCOT_SAYINGS[mascotClicks % MASCOT_SAYINGS.length]}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
