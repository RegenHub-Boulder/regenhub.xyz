"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Loader2,
  CheckCircle,
  ArrowLeft,
  Calendar,
  Zap,
  Users,
  Wifi,
  Coffee,
  MapPin,
  ArrowRight,
  Clock,
  UserCheck,
  Ticket,
  Key,
  Mail,
} from "lucide-react";
import HubEssentials from "@/components/portal/HubEssentials";
import regenHubFull from "@/assets/regenhub-full.svg";

export type FreeDayClaim = {
  id: number;
  email: string;
  name: string;
  claimed_date: string;
  day_code_id: number | null;
  status: "pending" | "reserved" | "activated" | "expired" | "cancelled";
};

type Props = {
  /** Set when user is authenticated but has no claim yet */
  authenticatedEmail?: string;
  /** Existing claim data */
  claim?: FreeDayClaim;
  /** Code from an already-activated claim */
  existingCode?: { code: string; expires_at: string | null };
  /** Inviter info from ?ref= query param */
  inviter?: { name: string; invite_code: string };
};

/** Format a Date as YYYY-MM-DD in Mountain Time (matches server) */
function toMountainDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d); // en-CA gives YYYY-MM-DD
}

function getTodayString(): string {
  return toMountainDateString(new Date());
}

/** Get the next weekday (Mon-Fri) as YYYY-MM-DD in Mountain Time */
function getNextWeekday(): string {
  const now = new Date();
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mtDayName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    weekday: "short",
  }).format(now);
  const dayIndex = dayNames.indexOf(mtDayName);
  const d = new Date(now);
  if (dayIndex === 0) d.setDate(d.getDate() + 1); // Sun → Mon
  if (dayIndex === 6) d.setDate(d.getDate() + 2); // Sat → Mon
  return toMountainDateString(d);
}

function getMaxDateString(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return toMountainDateString(d);
}

function isWeekend(dateStr: string): boolean {
  const day = new Date(dateStr + "T12:00:00").getDay();
  return day === 0 || day === 6;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export default function FreeDayForm({
  authenticatedEmail,
  claim,
  existingCode,
  inviter,
}: Props) {
  const router = useRouter();
  const today = getTodayString();

  // Form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState(authenticatedEmail ?? "");
  const [claimedDate, setClaimedDate] = useState(getNextWeekday());
  const [about, setAbout] = useState("");
  const [whyJoin, setWhyJoin] = useState("");

  // UI state
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submittedStatus, setSubmittedStatus] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Activation result
  const [doorCode, setDoorCode] = useState<string | null>(
    existingCode?.code ?? null
  );
  const [expiresAt, setExpiresAt] = useState<string | null>(
    existingCode?.expires_at ?? null
  );
  const [lockStatus, setLockStatus] = useState<string | null>(null);

  const isInvited = !!inviter;

  // ── Handlers ────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/freeday", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email: authenticatedEmail ?? email,
          claimed_date: claimedDate,
          invite_code: inviter?.invite_code || undefined,
          about: about.trim() || undefined,
          why_join: whyJoin.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to submit");

      if (json.authenticated) {
        router.refresh();
      } else {
        setSubmitted(true);
        setSubmittedStatus(json.status ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleActivate() {
    setActivating(true);
    setError(null);

    try {
      const res = await fetch("/api/freeday/activate", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Activation failed");

      setDoorCode(json.code);
      setExpiresAt(json.expires_at);
      setLockStatus(json.lock_status ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setActivating(false);
    }
  }

  // ── Render: Email sent ──────────────────────────────────────

  if (submitted) {
    const isPending = submittedStatus === "pending";
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <Card className="glass-panel-strong max-w-md w-full">
          <CardContent className="p-10 text-center">
            {isPending ? (
              <Clock className="w-12 h-12 text-sage mx-auto mb-4" />
            ) : (
              <CheckCircle className="w-12 h-12 text-sage mx-auto mb-4" />
            )}
            <h1 className="text-2xl font-bold text-forest mb-3">
              {isPending ? "Application Submitted!" : "Check Your Email!"}
            </h1>
            <p className="text-muted mb-2">
              We&apos;ve sent a sign-in link to{" "}
              <strong className="text-foreground">{email}</strong>.
            </p>
            <p className="text-sm text-muted mb-8">
              {isPending
                ? "A community member will review your application shortly. Click the email link to check your status."
                : "Click the link to confirm your email and get your free day pass code."}
            </p>
            <Link href="/">
              <Button variant="ghost" className="btn-glass gap-2">
                <ArrowLeft className="w-4 h-4" />
                Back to homepage
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Render: Pending approval ────────────────────────────────

  if (claim?.status === "pending") {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <Card className="glass-panel-strong max-w-md w-full">
          <CardContent className="p-10 text-center">
            <Clock className="w-12 h-12 text-sage mx-auto mb-4" />
<h1 className="text-2xl font-bold text-forest mb-3">
              Application Under Review
            </h1>
            <p className="text-muted mb-2">
              Your free day application for{" "}
              <strong className="text-foreground">
                {formatDate(claim.claimed_date)}
              </strong>{" "}
              is being reviewed.
            </p>
            <p className="text-sm text-muted mb-6">
              A community member will approve your visit shortly. Check back
              here or watch your email for updates.
            </p>
            <div className="glass-panel-subtle p-4 rounded-lg text-left space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted">
                <MapPin className="w-4 h-4 text-sage" />
                1515 Walnut St, Suite 200, Boulder
              </div>
              <div className="flex items-center gap-2 text-sm text-muted">
                <Coffee className="w-4 h-4 text-sage" />
                Hours: 8 AM – 6 PM
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Render: Expired claim ───────────────────────────────────

  if (claim?.status === "expired") {
    return (
      <div className="min-h-screen px-6 py-12">
        <div className="max-w-2xl mx-auto space-y-8">
          <div className="text-center">
            <Link href="/">
              <Image
                src={regenHubFull}
                alt="RegenHub"
                height={80}
                className="h-20 w-auto mx-auto mb-6 hover:opacity-80 transition-opacity"
              />
            </Link>
            <h1 className="text-3xl md:text-4xl font-bold text-forest mb-2">
              Hope You Enjoyed Your Day!
            </h1>
            <p className="text-muted">
              Your free day on{" "}
              <strong className="text-foreground">
                {formatDate(claim.claimed_date)}
              </strong>{" "}
              has passed. Here&apos;s how to come back.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <Card className="glass-panel hover-lift">
              <CardContent className="p-6">
                <Ticket className="w-8 h-8 text-gold mb-3" />
                <h3 className="font-semibold mb-1">Day Passes</h3>
                <p className="text-2xl font-bold text-gold mb-2">$25/day</p>
                <p className="text-sm text-muted mb-4">
                  Come back anytime with a day pass. No commitment, just buy a pass and get a door code.
                </p>
                <Link href="/portal/passes">
                  <Button className="btn-primary-glass w-full gap-2">
                    Get Day Passes
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                </Link>
              </CardContent>
            </Card>

            <Card className="glass-panel hover-lift">
              <CardContent className="p-6">
                <Key className="w-8 h-8 text-sage mb-3" />
                <h3 className="font-semibold mb-1">Desk Membership</h3>
                <p className="text-2xl font-bold text-gold mb-2">$250/mo</p>
                <p className="text-sm text-muted mb-4">
                  Get your own desk, a permanent door code, 24/7 access, and a path to co-op ownership.
                </p>
                <a href="mailto:boulder.regenhub@gmail.com?subject=Interested in desk membership">
                  <Button className="btn-glass w-full gap-2">
                    <Mail className="w-4 h-4" />
                    Inquire
                  </Button>
                </a>
              </CardContent>
            </Card>
          </div>

          <div className="text-center">
            <Link href="/portal" className="text-sm text-muted hover:text-sage transition-colors underline">
              Go to your portal
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Activated — show door code ──────────────────────

  if (claim?.status === "activated" || doorCode) {
    return (
      <div className="min-h-screen px-6 py-12">
        <div className="max-w-2xl mx-auto space-y-8">
          <div className="text-center">
            <Link href="/">
              <Image
                src={regenHubFull}
                alt="RegenHub"
                height={80}
                className="h-20 w-auto mx-auto mb-6 hover:opacity-80 transition-opacity"
              />
            </Link>
            <h1 className="text-3xl md:text-4xl font-bold text-forest mb-2">
              You&apos;re All Set!
            </h1>
            <p className="text-muted">
              Your free day at RegenHub is ready. Here&apos;s your door code.
            </p>
          </div>

          <Card className="glass-panel-strong">
            <CardContent className="p-8 text-center">
              <p className="text-sm text-muted mb-2 uppercase tracking-wider">
                Your Door Code
              </p>
              <p className="text-5xl md:text-6xl font-mono font-bold text-gold tracking-[0.2em] mb-4">
                {doorCode}
              </p>
              {expiresAt && (
                <p className="text-sm text-muted">
                  Valid until{" "}
                  <strong className="text-foreground">
                    {formatTime(expiresAt)}
                  </strong>
                </p>
              )}
              {lockStatus && (
                <p className={`text-sm mt-2 ${lockStatus.includes("didn't respond") ? "text-amber-400" : "text-emerald-400"}`}>
                  {lockStatus}
                </p>
              )}
            </CardContent>
          </Card>

          <HubEssentials defaultExpanded freeDay />

          <div className="glass-panel-subtle p-6 rounded-xl">
            <h3 className="text-sm font-semibold text-forest mb-4 text-center">
              Want to come back?
            </h3>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="text-center">
                <Ticket className="w-6 h-6 text-gold mx-auto mb-2" />
                <p className="text-sm font-medium mb-1">Day Pass — $25</p>
                <p className="text-xs text-muted mb-3">No commitment, just show up</p>
                <Link href="/portal/passes">
                  <Button size="sm" className="btn-primary-glass gap-1.5 text-xs">
                    Get passes <ArrowRight className="w-3 h-3" />
                  </Button>
                </Link>
              </div>
              <div className="text-center">
                <Key className="w-6 h-6 text-sage mx-auto mb-2" />
                <p className="text-sm font-medium mb-1">Desk — $250/mo</p>
                <p className="text-xs text-muted mb-3">Your own desk + 24/7 access</p>
                <a href="mailto:boulder.regenhub@gmail.com?subject=Interested in desk membership">
                  <Button size="sm" className="btn-glass gap-1.5 text-xs">
                    <Mail className="w-3 h-3" /> Inquire
                  </Button>
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Reserved for a future date ──────────────────────

  if (claim?.status === "reserved" && claim.claimed_date !== today) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <Card className="glass-panel-strong max-w-md w-full">
          <CardContent className="p-10 text-center">
            <Calendar className="w-12 h-12 text-sage mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-forest mb-3">
              You&apos;re Booked!
            </h1>
            <p className="text-muted mb-2">
              Your free day is reserved for
            </p>
            <p className="text-xl font-semibold text-gold mb-6">
              {formatDate(claim.claimed_date)}
            </p>
            <div className="glass-panel-subtle p-4 rounded-lg text-left space-y-2 mb-6">
              <div className="flex items-center gap-2 text-sm text-muted">
                <MapPin className="w-4 h-4 text-sage" />
                1515 Walnut St, Suite 200, Boulder
              </div>
              <div className="flex items-center gap-2 text-sm text-muted">
                <Coffee className="w-4 h-4 text-sage" />
                Hours: 8 AM – 6 PM
              </div>
            </div>
            <p className="text-xs text-muted">
              Come back to this page on your reserved day to get your door code.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Render: Reserved for today — activate button ────────────

  if (claim?.status === "reserved" && claim.claimed_date === today) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <Card className="glass-panel-strong max-w-md w-full">
          <CardContent className="p-10 text-center">
            <Zap className="w-12 h-12 text-gold mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-forest mb-3">
              Your Free Day is Today!
            </h1>
            <p className="text-muted mb-6">
              Ready to get your door code for RegenHub?
            </p>

            {error && (
              <p className="text-sm text-red-400 mb-4">{error}</p>
            )}

            <Button
              onClick={handleActivate}
              disabled={activating}
              className="btn-primary-glass w-full py-4 text-lg font-semibold gap-2"
            >
              {activating ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Zap className="w-5 h-5" />
              )}
              {activating ? "Setting up your code…" : "Get My Door Code"}
            </Button>

            <div className="glass-panel-subtle p-4 rounded-lg text-left space-y-2 mt-6">
              <div className="flex items-center gap-2 text-sm text-muted">
                <MapPin className="w-4 h-4 text-sage" />
                1515 Walnut St, Suite 200, Boulder
              </div>
              <div className="flex items-center gap-2 text-sm text-muted">
                <Coffee className="w-4 h-4 text-sage" />
                Hours: 8 AM – 6 PM
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Render: Landing page / signup form ──────────────────────

  return (
    <div className="min-h-screen px-6 py-12">
      <div className="max-w-2xl mx-auto space-y-8">
        {/* Hero */}
        <div className="text-center">
          <Link href="/">
            <Image
              src={regenHubFull}
              alt="RegenHub"
              height={80}
              className="h-20 w-auto mx-auto mb-6 hover:opacity-80 transition-opacity"
            />
          </Link>
          <h1 className="text-3xl md:text-4xl font-bold text-forest mb-3">
            Try RegenHub for a Day — On Us
          </h1>
          <p className="text-muted max-w-lg mx-auto">
            Experience Boulder&apos;s regenerative coworking space with a free
            day pass, Monday through Friday. No commitment — just show up and
            see if it&apos;s right for you.
          </p>
        </div>

        {/* Invite badge */}
        {isInvited && (
          <div className="flex items-center justify-center gap-2 text-sm">
            <div className="glass-panel-subtle px-4 py-2 rounded-full flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-sage" />
              <span className="text-muted">
                Invited by <strong className="text-foreground">{inviter.name}</strong>
              </span>
            </div>
          </div>
        )}

        {/* Value props */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { icon: Wifi, label: "High-speed fiber" },
            { icon: Coffee, label: "Coffee & kitchen" },
            { icon: Users, label: "Community vibes" },
            { icon: MapPin, label: "Downtown Boulder" },
          ].map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="glass-panel-subtle p-4 text-center rounded-xl"
            >
              <Icon className="w-6 h-6 text-sage mx-auto mb-2" />
              <p className="text-xs text-muted">{label}</p>
            </div>
          ))}
        </div>

        {/* Form */}
        <Card className="glass-panel">
          <CardContent className="p-8">
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Your name *</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    placeholder="Full name"
                    className="glass-input"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email *</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="you@example.com"
                    className="glass-input"
                    readOnly={!!authenticatedEmail}
                    disabled={!!authenticatedEmail}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="date">When would you like to come in? *</Label>
                <Input
                  id="date"
                  type="date"
                  value={claimedDate}
                  onChange={(e) => {
                    const val = e.target.value;
                    setClaimedDate(val);
                    if (isWeekend(val)) {
                      setError("Free day passes are available Monday through Friday only");
                    } else {
                      setError(null);
                    }
                  }}
                  min={today}
                  max={getMaxDateString()}
                  required
                  className="glass-input"
                />
                <p className="text-xs text-muted">
                  {isWeekend(claimedDate)
                    ? "⚠️ Weekends are not available — please select a weekday (Mon–Fri)."
                    : claimedDate === today
                      ? "Today — you'll get your door code right away after confirming your email."
                      : `${formatDate(claimedDate)} — come back to this page on that day to get your code.`}
                </p>
              </div>

              {/* Application questions — shown when no invite */}
              {!isInvited && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="about">What are you working on? *</Label>
                    <textarea
                      id="about"
                      value={about}
                      onChange={(e) => setAbout(e.target.value)}
                      rows={3}
                      required
                      placeholder="Projects, interests, skills — give us a feel for what you bring to the community"
                      className="w-full rounded-md px-3 py-2 text-sm glass-input resize-none"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="why_join">Why do you want to visit RegenHub? *</Label>
                    <textarea
                      id="why_join"
                      value={whyJoin}
                      onChange={(e) => setWhyJoin(e.target.value)}
                      rows={3}
                      required
                      placeholder="What draws you to regenerative community? What are you hoping to find here?"
                      className="w-full rounded-md px-3 py-2 text-sm glass-input resize-none"
                    />
                  </div>
                </>
              )}

              {error && <p className="text-sm text-red-400">{error}</p>}

              <Button
                type="submit"
                disabled={loading || isWeekend(claimedDate)}
                className="btn-primary-glass w-full py-3 text-base font-semibold gap-2"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Zap className="w-4 h-4" />
                )}
                {loading
                  ? "Submitting…"
                  : isInvited
                    ? "Claim Your Free Day"
                    : "Apply for a Free Day"}
              </Button>

              <p className="text-xs text-center text-muted">
                Already a member?{" "}
                <Link
                  href="/portal"
                  className="underline hover:text-sage transition-colors"
                >
                  Sign in to your portal
                </Link>
              </p>
            </form>
          </CardContent>
        </Card>

        {/* How it works */}
        <div className="glass-panel-subtle p-6 rounded-xl">
          <h3 className="text-sm font-semibold text-forest mb-3 text-center">
            How it works
          </h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            {(isInvited
              ? [
                  { step: "1", text: "Confirm your email" },
                  { step: "2", text: "Get your door code" },
                  { step: "3", text: "Show up & co-work!" },
                ]
              : [
                  { step: "1", text: "Apply & confirm email" },
                  { step: "2", text: "Get approved" },
                  { step: "3", text: "Show up & co-work!" },
                ]
            ).map(({ step, text }) => (
<div key={step}>
                <div className="w-8 h-8 rounded-full bg-forest/30 border border-sage/30 flex items-center justify-center mx-auto mb-2">
                  <span className="text-sm font-bold text-sage">{step}</span>
                </div>
                <p className="text-xs text-muted">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
