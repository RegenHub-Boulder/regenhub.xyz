import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Building2,
  HandHeart,
  Lightbulb,
  Sprout,
  MapPin,
  Calendar,
  Mail,
} from "lucide-react";
import forestBackground from "@/assets/forest-background.jpg";
import particlesOverlay from "@/assets/particles-overlay.png";
import forestMascot from "@/assets/forest-mascot.png";
import CommunityGallery from "./CommunityGallery";

const RegenHubLanding = () => {
  const [mascotPosition, setMascotPosition] = useState({
    x: 0,
    y: 0,
    rotate: 0,
    scale: 1,
  });
  const [mascotClicks, setMascotClicks] = useState(0);

  const handleMascotClick = () => {
    // Bigger, more dynamic movement
    const newX = (Math.random() - 0.5) * 400;
    const newY = (Math.random() - 0.5) * 300;
    const newRotate = (Math.random() - 0.5) * 720; // Full spins!
    const newScale = 0.8 + Math.random() * 0.6; // Scale between 0.8 and 1.4

    setMascotPosition({ x: newX, y: newY, rotate: newRotate, scale: newScale });
    setMascotClicks((prev) => prev + 1);

    // Reset position after animation with a slight bounce
    setTimeout(() => {
      setMascotPosition({ x: 0, y: 0, rotate: 0, scale: 1 });
    }, 1500);
  };
  return (
    <div className="min-h-screen relative overflow-x-hidden">
      {/* Forest Background Layers */}
      <div
        className="fixed inset-0 -z-10"
        style={{
          background: `url(${forestBackground})`,
          backgroundSize: "150% 150%",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          opacity: 0.3,
        }}
      />
      <div
        className="fixed inset-0 -z-10 pointer-events-none"
        style={{
          backgroundImage: `url(${particlesOverlay})`,
          backgroundSize: "100% 100%",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          opacity: 0.1,
          animation: "float-particles 60s ease-in-out infinite",
        }}
      />

      {/* Header */}
      <header className="relative z-50 px-6 py-4">
        <nav className="glass-panel-subtle max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl animate-sway">🌱</span>
            <h1 className="text-2xl font-bold text-forest bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
              RegenHub
            </h1>
          </div>
          <p className="text-sm text-muted-foreground font-medium hidden sm:block">
            Boulder's Regenerative Workspace
          </p>
        </nav>
      </header>

      {/* Hero Section */}
      <section className="relative px-6 py-16 md:py-24">
        <div className="max-w-4xl mx-auto text-center relative">
          {/* Forest Mascot */}
          <div
            className="absolute -right-12 top-4 hidden lg:block animate-fade-in z-10 cursor-pointer"
            style={{
              transform: `translate(${mascotPosition.x}px, ${mascotPosition.y}px) rotate(${mascotPosition.rotate}deg) scale(${mascotPosition.scale})`,
              transition:
                "transform 0.8s cubic-bezier(0.68, -0.55, 0.265, 1.55)",
            }}
            onClick={handleMascotClick}
            title="Click me!"
          >
            <img
              src={forestMascot}
              alt="RegenHub Forest Mascot"
              className="w-48 h-48 object-contain opacity-80 hover:opacity-100 hover:scale-110 transition-all duration-300 animate-sway"
            />
            {mascotClicks > 0 && mascotClicks < 3 && (
              <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-white/90 px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap">
                Scenius emerges! 🌿
              </div>
            )}
            {mascotClicks >= 3 && mascotClicks < 6 && (
              <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-white/90 px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap">
                Collective genius activated! ✨
              </div>
            )}
            {mascotClicks >= 6 && mascotClicks < 9 && (
              <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-white/90 px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap">
                1 + 1 = 11 here! 🚀
              </div>
            )}
            {mascotClicks >= 9 && (
              <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-white/90 px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap">
                We build the future together! 💚
              </div>
            )}
          </div>
          <div className="glass-panel-strong p-8 md:p-12 hover-lift animate-fade-in-up">
            <h2 className="text-4xl md:text-6xl font-bold mb-6 text-foreground leading-tight">
              A regenerative third space for aligned builders
            </h2>
            <p className="text-xl md:text-2xl mb-8 text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              Cooperative workspace. Economic democracy. Regenerative futures.
            </p>
          </div>
        </div>
      </section>

      {/* What We Offer Section */}
      <section className="relative px-6 py-16">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">
              What We Offer
            </h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              Community. Democracy. Regeneration.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            <Card className="glass-panel hover-lift group">
              <CardContent className="p-6 text-center">
                <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center rounded-full bg-primary/10">
                  <Building2 className="w-8 h-8 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-3 text-foreground">
                  Community Infrastructure
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  Affordable co-working and event space for regenerative
                  builders and changemakers.
                </p>
              </CardContent>
            </Card>

            <Card className="glass-panel hover-lift group">
              <CardContent className="p-6 text-center">
                <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center rounded-full bg-accent/10">
                  <HandHeart className="w-8 h-8 text-accent" />
                </div>
                <h3 className="text-xl font-semibold mb-3 text-foreground">
                  Economic Democracy
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  Meaningful ownership and governance through profit-sharing and
                  equity.
                </p>
              </CardContent>
            </Card>

            <Card className="glass-panel hover-lift group">
              <CardContent className="p-6 text-center">
                <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center rounded-full bg-secondary/20">
                  <Sprout className="w-8 h-8 text-secondary" />
                </div>
                <h3 className="text-xl font-semibold mb-3 text-foreground">
                  Regenerative Technology Incubation
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  Mentorship and support for climate, social equity, and
                  sustainability projects.
                </p>
              </CardContent>
            </Card>

            <Card className="glass-panel hover-lift group">
              <CardContent className="p-6 text-center">
                <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center rounded-full bg-primary/10">
                  <Lightbulb className="w-8 h-8 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-3 text-foreground">
                  Collective Intelligence
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  Building 'scenius' - collective intelligence through sustained
                  collaboration.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Community Gallery */}
      <CommunityGallery />

      {/* Membership Section */}
      <section className="relative px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">
              Become Part of the Cooperative
            </h2>
            <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
              Tiered membership with participation-based governance and economic
              sharing.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6 mb-8">
            <Card className="glass-panel hover-lift border-l-4 border-l-secondary">
              <CardContent className="p-6">
                <h3 className="text-xl font-semibold mb-3 text-foreground">
                  Community Participants
                </h3>
                <p className="text-muted-foreground mb-4">
                  Access events and resources for mission-aligned individuals.
                </p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Event access</li>
                  <li>• Resource library</li>
                  <li>• Community network</li>
                </ul>
              </CardContent>
            </Card>

            <Card className="glass-panel hover-lift border-l-4 border-l-accent">
              <CardContent className="p-6">
                <h3 className="text-xl font-semibold mb-3 text-foreground">
                  Part-time Contributors
                </h3>
                <p className="text-muted-foreground mb-4">
                  Co-working access and governance for active community
                  builders.
                </p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Co-working access</li>
                  <li>• Governance participation</li>
                  <li>• Project collaboration</li>
                </ul>
              </CardContent>
            </Card>

            <Card className="glass-panel hover-lift border-l-4 border-l-primary">
              <CardContent className="p-6">
                <h3 className="text-xl font-semibold mb-3 text-foreground">
                  Full-time Cooperative Members
                </h3>
                <p className="text-muted-foreground mb-4">
                  Full ownership and governance for committed regenerative
                  entrepreneurs.
                </p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Full ownership rights</li>
                  <li>• Governance participation</li>
                  <li>• Equity distribution</li>
                </ul>
              </CardContent>
            </Card>
          </div>

          <div className="text-center">
            <Button
              className="btn-primary-glass px-8 py-3 text-lg font-semibold hover-glow"
              asChild
            >
              <a
                href="https://airtable.com/appccpfHK9zFWYR6g/shrAGo58nsstawTjQ"
                target="_blank"
                rel="noopener noreferrer"
              >
                Apply for Membership
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* Members Section */}
      <section className="relative px-6 py-16">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">
              Our Community
            </h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              Builders, creators, and changemakers shaping regenerative futures
            </p>
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

      {/* Events Section */}
      <section className="relative px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="glass-panel-subtle p-8 md:p-12">
            <div className="text-center mb-12">
              <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">
                Upcoming Events
              </h2>
              <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
                Join us for community building, learning, and collaboration
              </p>
            </div>

            <div className="glass-panel-subtle rounded-lg overflow-hidden">
              <div className="relative w-full" style={{ paddingBottom: "75%" }}>
                <iframe
                  src="https://luma.com/embed/calendar/cal-ZCWMKx1NMCXGd7v/events?lt=light"
                  className="absolute top-0 left-0 w-full h-full"
                  frameBorder="0"
                  style={{ border: "1px solid #bfcbda88", borderRadius: "4px" }}
                  allowFullScreen
                  aria-hidden="false"
                  tabIndex={0}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Location/Contact Section */}
      <section className="relative px-6 py-16">
        <div className="max-w-4xl mx-auto">
          <Card className="glass-panel-strong hover-lift">
            <CardContent className="p-8 md:p-12 text-center">
              <h2 className="text-3xl md:text-4xl font-bold mb-8 text-forest">
                Find Us in Boulder
              </h2>

              <div className="glass-panel-subtle p-6 mb-8 bg-accent/5">
                <h3 className="text-lg font-semibold mb-3 text-foreground">
                  Important Note
                </h3>
                <p className="text-muted-foreground mb-2">
                  RegenHub Boulder is an <strong>invite-only space</strong>.
                  You're welcome to attend our public events and inquire about
                  membership and day passes in our community channels.
                </p>
                <p className="text-sm text-muted-foreground">
                  Please apply first before purchasing a membership.
                </p>
              </div>

              <div className="grid md:grid-cols-2 gap-8 mb-8">
                <div className="space-y-4">
                  <div className="flex items-center justify-center gap-2">
                    <MapPin className="w-5 h-5 text-primary" />
                    <span className="text-lg font-medium">Address</span>
                  </div>
                  <div className="text-muted-foreground">
                    <p>1515 Walnut St, Ste 200</p>
                    <p>Boulder, CO 80302</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-center gap-2">
                    <Calendar className="w-5 h-5 text-primary" />
                    <span className="text-lg font-medium">Access</span>
                  </div>
                  <div className="text-muted-foreground">
                    <p>Members & Day Pass Holders</p>
                    <p>Public Events Welcome</p>
                  </div>
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-6 mb-8">
                <div className="flex items-center justify-center gap-2">
                  <Mail className="w-5 h-5 text-primary" />
                  <a
                    href="mailto:boulder.regenhub@gmail.com"
                    className="text-lg font-medium hover:text-primary transition-colors"
                  >
                    boulder.regenhub@gmail.com
                  </a>
                </div>

                <div className="flex items-center justify-center gap-2">
                  <span className="text-2xl">📱</span>
                  <a
                    href="https://t.me/+Mg1PLuT9pX9mMGVh"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-lg font-medium hover:text-primary transition-colors"
                  >
                    Community Telegram
                  </a>
                </div>
              </div>

              <div className="glass-panel-subtle p-4 mb-6 text-sm text-muted-foreground">
                <p>
                  <strong>WiFi Network:</strong> regenhub.xyz_guest
                </p>
                <p>
                  <strong>WiFi Password:</strong> itsallcoordination
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Button className="btn-primary-glass px-6 py-2" asChild>
                  <a
                    href="https://airtable.com/appccpfHK9zFWYR6g/shrAGo58nsstawTjQ"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Apply for Membership
                  </a>
                </Button>
                <Button className="btn-glass px-6 py-2" asChild>
                  <a
                    href="https://luma.com/regenhub"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View All Events
                  </a>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative px-6 py-12 mt-16">
        <div className="max-w-4xl mx-auto">
          <div className="glass-panel p-8 text-center">
            <div className="flex items-center justify-center gap-3 mb-4">
              <span className="text-2xl animate-sway">🌱</span>
              <h3 className="text-2xl font-bold text-forest bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
                RegenHub
              </h3>
            </div>

            <p className="text-lg font-medium mb-2 text-foreground">
              Building economic democracy and regenerative livelihoods
            </p>

            <div className="text-sm text-muted-foreground space-y-1 mb-6">
              <p>© 2025 RegenHub Limited Cooperative Association</p>
              <p>A Colorado Public Benefit Corporation</p>
            </div>

            <div className="flex justify-center gap-4">
              <Button variant="ghost" size="sm" className="btn-glass" asChild>
                <a
                  href="https://t.me/+Mg1PLuT9pX9mMGVh"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Telegram
                </a>
              </Button>
              <Button variant="ghost" size="sm" className="btn-glass" asChild>
                <a href="mailto:boulder.regenhub@gmail.com">Email</a>
              </Button>
              <Button variant="ghost" size="sm" className="btn-glass" asChild>
                <a
                  href="https://airtable.com/appccpfHK9zFWYR6g/shrAGo58nsstawTjQ"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Apply
                </a>
              </Button>
              <Button variant="ghost" size="sm" className="btn-glass" asChild>
                <a
                  href="https://luma.com/regenhub"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Events
                </a>
              </Button>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default RegenHubLanding;
