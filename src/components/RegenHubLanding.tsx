import React from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Building2, HandHeart, Lightbulb, Sprout, MapPin, Calendar, Mail } from 'lucide-react';
import forestBackground from '@/assets/forest-background.jpg';
import particlesOverlay from '@/assets/particles-overlay.png';

const RegenHubLanding = () => {
  return (
    <div className="min-h-screen relative overflow-x-hidden">
      {/* Forest Background Layers */}
      <div className="forest-bg">
        <div 
          className="forest-pattern"
          style={{ backgroundImage: `url(${forestBackground})` }}
        />
        <div 
          className="floating-particles"
          style={{ backgroundImage: `url(${particlesOverlay})` }}
        />
      </div>

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
        <div className="max-w-4xl mx-auto text-center">
          <div className="glass-panel-strong p-8 md:p-12 hover-lift animate-fade-in-up">
            <h2 className="text-4xl md:text-6xl font-bold mb-6 text-glass leading-tight">
              Where Builders Shape Tomorrow
            </h2>
            <p className="text-xl md:text-2xl mb-8 text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              A regenerative third space that transforms coordinated action into collective impact
            </p>
            <div className="prose prose-lg max-w-3xl mx-auto mb-8 text-foreground/80">
              <p>
                RegenHub enables aligned technologists, creators, and changemakers to build sustainable livelihoods 
                while advancing projects that benefit our broader community and environment. We're demonstrating 
                viable alternatives to traditional capitalism through cooperative ownership and shared success.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
              <Button className="btn-primary-glass px-8 py-3 text-lg font-semibold hover-glow">
                Join Our Community
              </Button>
              <Button className="btn-glass px-8 py-3 text-lg font-semibold">
                Learn More
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* What We Offer Section */}
      <section className="relative px-6 py-16">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">What We Offer</h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              Building the infrastructure for regenerative community and economic democracy
            </p>
          </div>
          
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            <Card className="glass-panel hover-lift group">
              <CardContent className="p-6 text-center">
                <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center rounded-full bg-primary/10">
                  <Building2 className="w-8 h-8 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-3 text-foreground">Community Infrastructure</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Maintain affordable co-working and event space accessible to regenerative movement participants 
                  including builders, changemakers, and creatives.
                </p>
              </CardContent>
            </Card>

            <Card className="glass-panel hover-lift group">
              <CardContent className="p-6 text-center">
                <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center rounded-full bg-accent/10">
                  <HandHeart className="w-8 h-8 text-accent" />
                </div>
                <h3 className="text-xl font-semibold mb-3 text-foreground">Economic Democracy</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Extend meaningful ownership and governance participation to community members through 
                  profit-sharing and equity distribution.
                </p>
              </CardContent>
            </Card>

            <Card className="glass-panel hover-lift group">
              <CardContent className="p-6 text-center">
                <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center rounded-full bg-secondary/20">
                  <Sprout className="w-8 h-8 text-secondary" />
                </div>
                <h3 className="text-xl font-semibold mb-3 text-foreground">Regenerative Technology Incubation</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Provide early-stage funding, mentorship, and infrastructure support for projects addressing 
                  climate, social equity, and economic sustainability challenges.
                </p>
              </CardContent>
            </Card>

            <Card className="glass-panel hover-lift group">
              <CardContent className="p-6 text-center">
                <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center rounded-full bg-primary/10">
                  <Lightbulb className="w-8 h-8 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-3 text-foreground">Collective Intelligence</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Foster 'scenius' - collective intelligence through sustained collaboration of 
                  culturally aligned peers.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Membership Section */}
      <section className="relative px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">Become Part of the Cooperative</h2>
            <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
              RegenHub operates through tiered, participation-based membership including full-time cooperative members, 
              part-time contributors, and community participants, each with appropriate governance rights and economic participation.
            </p>
          </div>
          
          <div className="grid md:grid-cols-3 gap-6 mb-8">
            <Card className="glass-panel hover-lift border-l-4 border-l-secondary">
              <CardContent className="p-6">
                <h3 className="text-xl font-semibold mb-3 text-foreground">Community Participants</h3>
                <p className="text-muted-foreground mb-4">
                  Access to events and resources for mission-aligned individuals exploring regenerative pathways.
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
                <h3 className="text-xl font-semibold mb-3 text-foreground">Part-time Contributors</h3>
                <p className="text-muted-foreground mb-4">
                  Co-working access and profit-sharing eligible for active community builders.
                </p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Co-working access</li>
                  <li>• Profit-sharing eligible</li>
                  <li>• Project collaboration</li>
                </ul>
              </CardContent>
            </Card>

            <Card className="glass-panel hover-lift border-l-4 border-l-primary">
              <CardContent className="p-6">
                <h3 className="text-xl font-semibold mb-3 text-foreground">Full-time Cooperative Members</h3>
                <p className="text-muted-foreground mb-4">
                  Full ownership and governance rights for committed regenerative entrepreneurs.
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
            <Button className="btn-primary-glass px-8 py-3 text-lg font-semibold hover-glow">
              Apply for Membership
            </Button>
          </div>
        </div>
      </section>

      {/* Programs Section */}
      <section className="relative px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="glass-panel-subtle p-8 md:p-12">
            <div className="text-center mb-12">
              <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">Living Programs</h2>
              <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
                Curate programming that builds social cohesion and cross-pollination of ideas among mission-aligned individuals
              </p>
            </div>
            
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                'Happy Hour',
                'Vibe Coding Night', 
                'Studio Nights',
                'CoHere Sessions',
                'Boulder Blockchain Meetups',
                'Technical Education Workshops'
              ].map((program, index) => (
                <div key={index} className="glass-panel-subtle p-4 hover-lift text-center">
                  <Calendar className="w-6 h-6 mx-auto mb-2 text-primary" />
                  <p className="font-medium text-foreground">{program}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Location/Contact Section */}
      <section className="relative px-6 py-16">
        <div className="max-w-4xl mx-auto">
          <Card className="glass-panel-strong hover-lift">
            <CardContent className="p-8 md:p-12 text-center">
              <h2 className="text-3xl md:text-4xl font-bold mb-8 text-forest">Find Us in Boulder</h2>
              
              <div className="glass-panel-subtle p-6 mb-8 bg-accent/5">
                <h3 className="text-lg font-semibold mb-3 text-foreground">Important Note</h3>
                <p className="text-muted-foreground mb-2">
                  RegenHub Boulder is an <strong>invite-only space</strong>. You're welcome to attend our public events 
                  and inquire about membership and day passes in our community channels.
                </p>
                <p className="text-sm text-muted-foreground">Please apply first before purchasing a membership.</p>
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
                  <a href="mailto:boulder.regenhub@gmail.com" className="text-lg font-medium hover:text-primary transition-colors">
                    boulder.regenhub@gmail.com
                  </a>
                </div>
                
                <div className="flex items-center justify-center gap-2">
                  <span className="text-2xl">📱</span>
                  <a href="https://t.me/+Mg1PLuT9pX9mMGVh" target="_blank" rel="noopener noreferrer" className="text-lg font-medium hover:text-primary transition-colors">
                    Community Telegram
                  </a>
                </div>
              </div>
              
              <div className="glass-panel-subtle p-4 mb-6 text-sm text-muted-foreground">
                <p><strong>WiFi Network:</strong> regenhub.xyz_guest</p>
                <p><strong>WiFi Password:</strong> itsallcoordination</p>
              </div>
              
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Button className="btn-primary-glass px-6 py-2">
                  Apply for Membership
                </Button>
                <Button className="btn-glass px-6 py-2">
                  Submit an Event
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
                <a href="https://t.me/+Mg1PLuT9pX9mMGVh" target="_blank" rel="noopener noreferrer">
                  Telegram
                </a>
              </Button>
              <Button variant="ghost" size="sm" className="btn-glass" asChild>
                <a href="mailto:boulder.regenhub@gmail.com">
                  Email
                </a>
              </Button>
              <Button variant="ghost" size="sm" className="btn-glass">Apply</Button>
              <Button variant="ghost" size="sm" className="btn-glass">Events</Button>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default RegenHubLanding;