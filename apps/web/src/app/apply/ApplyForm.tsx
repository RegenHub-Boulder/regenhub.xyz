"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import regenHubFull from "@/assets/regenhub-full.svg";

const ACCESS_OPTIONS = [
  { value: "daypass_single", label: "Single Day Pass ($30, or $25 for members)", desc: "Occasional drop-in access, one at a time" },
  { value: "member_basic", label: "Member + 1 day/mo ($30/mo)", desc: "Member access + 1 coworking day per month (passes accumulate) + member rate on additional day passes" },
  { value: "member_2day", label: "Member + 2 days/mo ($50/mo)", desc: "Member access plus 2 days of coworking per month, auto-credited" },
  { value: "member_5day", label: "Member + 5 days/mo ($100/mo)", desc: "Member access plus 5 days of coworking per month, auto-credited" },
  { value: "hot_desk", label: "Full Access — Hot Desk ($250/mo)", desc: "Permanent door code, 24/7 access to any open desk. We'll reach out for a quick chat before activating — Full Access is a deeper commitment." },
  { value: "reserved_desk", label: "Full Access — Cold Desk ($500/mo)", desc: "Your own reserved desk + permanent door code + 24/7 access. We'll reach out for a quick chat before activating — Full Access is a deeper commitment." },
] as const;

type Props = {
  /** The signed-in user's email — locked in the form; the application links to their account. */
  authenticatedEmail: string;
};

export default function ApplyForm({ authenticatedEmail }: Props) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "",
    email: authenticatedEmail,
    telegram: "",
    about: "",
    why_join: "",
    membership_interest: "member_basic" as "daypass_5pack" | "daypass_single" | "hot_desk" | "reserved_desk" | "member_basic" | "member_2day" | "member_5day",
  });
  const [loading, setLoading] = useState(false);
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
      // Always authenticated here — /apply gates on sign-in, so the application
      // links to the user's account (email + supabase_user_id) immediately.
      const res = await fetch("/api/portal/application", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          telegram: form.telegram,
          about: form.about,
          why_join: form.why_join,
          membership_interest: form.membership_interest,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to submit");
      router.push("/portal");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
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
                    required
                    placeholder="you@example.com"
                    className="glass-input"
                    readOnly
                    disabled
                  />
                  <p className="text-xs text-muted">Linked to your signed-in account.</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="telegram">Telegram username (optional)</Label>
                <Input
                  id="telegram"
                  value={form.telegram}
                  onChange={set("telegram")}
                  placeholder="@yourhandle"
                  className="glass-input"
                />
                <p className="text-xs text-muted">
                  We use Telegram for member coordination and access codes. Adding your handle helps us reach you faster.
                </p>
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
            </form>
          </CardContent>
        </Card>

        <Card className="glass-panel">
          <CardContent className="p-6 text-sm text-muted text-center">
            <p className="text-foreground font-medium mb-1">Need support with anything?</p>
            <p>
              Reach out to <span className="text-foreground">Aaron Gabriel</span>, our member coordinator.
              Email{" "}
              <a href="mailto:ag@unforced.org" className="underline hover:text-sage transition-colors">
                ag@unforced.org
              </a>{" "}
              or message{" "}
              <a href="https://t.me/unforcedAG" target="_blank" rel="noopener noreferrer" className="underline hover:text-sage transition-colors">
                @unforcedAG
              </a>{" "}
              on Telegram.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
