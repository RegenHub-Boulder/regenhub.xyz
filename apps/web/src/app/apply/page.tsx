"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, CheckCircle, ArrowLeft } from "lucide-react";
import regenHubFull from "@/assets/regenhub-full.svg";

const ACCESS_OPTIONS = [
  { value: "daypass_5pack", label: "5-Pack Day Passes", desc: "Flexible drop-in access — buy a 5-pack and use them whenever you need a desk" },
  { value: "daypass_single", label: "Single Day Passes", desc: "Occasional drop-in access, purchased one at a time" },
  { value: "hot_desk", label: "Hot Desk Membership", desc: "Regular monthly access — a dedicated place in the community with full membership benefits" },
  { value: "reserved_desk", label: "Reserved Desk", desc: "Your own dedicated desk, always available, full cooperative membership" },
] as const;

export default function ApplyPage() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    about: "",
    why_join: "",
    membership_interest: "daypass_5pack" as "daypass_5pack" | "daypass_single" | "hot_desk" | "reserved_desk",
  });
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to submit");
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <Card className="glass-panel-strong max-w-md w-full">
          <CardContent className="p-10 text-center">
            <CheckCircle className="w-12 h-12 text-sage mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-forest mb-3">Application Submitted!</h1>
            <p className="text-muted mb-2">
              We&apos;ve received your application and sent a sign-in link to{" "}
              <strong className="text-foreground">{form.email}</strong>.
            </p>
            <p className="text-sm text-muted mb-8">
              Click the link in your email to access your portal and track your application status.
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

  return (
    <div className="min-h-screen px-6 py-12">
      <div className="max-w-2xl mx-auto space-y-8">
        <div className="text-center">
          <Link href="/">
            <Image src={regenHubFull} alt="RegenHub" height={80} className="h-20 w-auto mx-auto mb-6 hover:opacity-80 transition-opacity" />
          </Link>
          <h1 className="text-3xl md:text-4xl font-bold text-forest mb-3">Apply for Membership</h1>
          <p className="text-muted max-w-md mx-auto">
            Join Boulder&apos;s regenerative innovation hub. We&apos;ll review your application and be in touch.
          </p>
        </div>

        <Card className="glass-panel">
          <CardContent className="p-8">
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Full name *</Label>
                  <Input
                    id="name"
                    value={form.name}
                    onChange={set("name")}
                    required
                    placeholder="Your name"
                    className="glass-input"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email *</Label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={set("email")}
                    required
                    placeholder="you@example.com"
                    className="glass-input"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="membership_interest">What level of access are you interested in?</Label>
                <select
                  id="membership_interest"
                  value={form.membership_interest}
                  onChange={set("membership_interest")}
                  className="w-full rounded-md px-3 py-2 text-sm glass-input"
                >
                  {ACCESS_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <p className="text-xs text-muted">
                  {ACCESS_OPTIONS.find(t => t.value === form.membership_interest)?.desc}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="about">What are you working on?</Label>
                <textarea
                  id="about"
                  value={form.about}
                  onChange={set("about")}
                  rows={3}
                  placeholder="Projects, interests, skills — give us a feel for what you bring to the community"
                  className="w-full rounded-md px-3 py-2 text-sm glass-input resize-none"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="why_join">Why do you want to join RegenHub?</Label>
                <textarea
                  id="why_join"
                  value={form.why_join}
                  onChange={set("why_join")}
                  rows={3}
                  placeholder="What draws you to regenerative community? What are you hoping to find here?"
                  className="w-full rounded-md px-3 py-2 text-sm glass-input resize-none"
                />
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <Button
                type="submit"
                disabled={loading}
                className="btn-primary-glass w-full py-3 text-base font-semibold gap-2"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {loading ? "Submitting…" : "Submit Application"}
              </Button>

              <p className="text-xs text-center text-muted">
                Already a member?{" "}
                <Link href="/portal" className="underline hover:text-sage transition-colors">
                  Sign in to your portal
                </Link>
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
