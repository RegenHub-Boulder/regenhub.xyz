"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import regenHubFull from "@/assets/regenhub-full.svg";

type Props = {
  /** The signed-in user's email — locked when real; empty for BYOD/synthetic so they type one. */
  authenticatedEmail: string;
  /** Prefill from the applicant's account / prior application. */
  initial?: {
    name?: string | null;
    about?: string | null;
    how_found?: string | null;
    knownBy?: { id: number; name: string } | null;
  };
};

type Pick = { id: number; name: string };

/**
 * The application (T-482 round 5): a minute's worth. Name, email, what you work on, how you found us, and who here
 * knows you. No level: once a member vouches and a steward approves, they pick any day plan themselves.
 */
export default function ApplyForm({ authenticatedEmail, initial }: Props) {
  const router = useRouter();
  const emailLocked = Boolean(authenticatedEmail);
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    email: authenticatedEmail,
    about: initial?.about ?? "",
    how_found: initial?.how_found ?? "",
  });
  // "Who here knows you?": a member picked from the list, or nobody yet.
  const [knownBy, setKnownBy] = useState<Pick | null>(initial?.knownBy ?? null);
  const [nobody, setNobody] = useState(false);
  const [query, setQuery] = useState(initial?.knownBy?.name ?? "");
  const [matches, setMatches] = useState<Pick[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (knownBy || nobody || query.trim().length < 2) { setMatches([]); return; }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const res = await fetch(`/api/portal/members/search?q=${encodeURIComponent(query.trim())}`).catch(() => null);
      const json = res?.ok ? await res.json().catch(() => null) : null;
      if (mine === seq.current) setMatches((json?.members ?? []) as Pick[]);
    }, 200);
    return () => clearTimeout(t);
  }, [query, knownBy, nobody]);

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!knownBy && !nobody) {
      setError("Pick the member who knows you, or \"Nobody yet\".");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/application", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          ...(emailLocked ? {} : { email: form.email }),
          about: form.about,
          how_found: form.how_found,
          known_by_member_id: nobody ? null : knownBy?.id ?? null,
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
    <div className="px-6 py-12">
      <div className="max-w-xl mx-auto space-y-8">
        <div className="text-center">
          <Link href="/">
            <Image src={regenHubFull} alt="RegenHub" height={80} className="h-16 w-auto mx-auto mb-5 hover:opacity-80 transition-opacity" />
          </Link>
          <h1 className="text-3xl md:text-4xl font-bold text-forest mb-3">Apply to join</h1>
          <p className="text-muted max-w-md mx-auto">
            A member who knows you vouches, a steward approves, and then you pick a day plan. We reply within a day.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6" data-testid="apply-form">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={form.name} onChange={set("name")} required placeholder="Your name" className="glass-input" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={emailLocked ? undefined : set("email")}
                required
                placeholder="you@example.com"
                className="glass-input"
                readOnly={emailLocked}
                disabled={emailLocked}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="about">What are you working on?</Label>
            <textarea
              id="about"
              value={form.about}
              onChange={set("about")}
              rows={3}
              required
              placeholder="A line or two is plenty"
              className="w-full rounded-md px-3 py-2 text-sm glass-input resize-none"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="how_found">How did you find us?</Label>
            <Input id="how_found" value={form.how_found} onChange={set("how_found")} placeholder="A friend, a night, a search…" className="glass-input" />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium mb-2">Who here knows you?</legend>
            {knownBy ? (
              <p className="text-sm flex items-center gap-3">
                <span className="text-foreground font-medium">{knownBy.name}</span>
                <button type="button" className="text-sage hover:underline" onClick={() => { setKnownBy(null); setQuery(""); }}>
                  Change
                </button>
              </p>
            ) : (
              <div className={`relative ${nobody ? "opacity-50" : ""}`}>
                <Input
                  id="known_by"
                  aria-label="Search members by name"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Start typing a member's name"
                  className="glass-input"
                  disabled={nobody}
                  autoComplete="off"
                />
                {matches.length > 0 && (
                  <ul role="listbox" className="absolute z-10 mt-1 w-full border border-rule bg-background shadow-sm">
                    {matches.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-tint"
                          onClick={() => { setKnownBy(m); setQuery(m.name); setMatches([]); }}
                        >
                          {m.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <label className="flex items-start gap-2 text-sm text-muted pt-1">
              <input
                type="checkbox"
                checked={nobody}
                onChange={(e) => { setNobody(e.target.checked); if (e.target.checked) setKnownBy(null); }}
                className="mt-1"
              />
              <span>Nobody yet. I&apos;ll come to a night or a free day first.</span>
            </label>
            <p className="text-xs text-muted">The member you name is asked to vouch for you. One vouch is all it takes.</p>
          </fieldset>

          {error && <p className="text-sm text-danger">{error}</p>}

          <Button type="submit" disabled={loading} className="btn-primary-glass w-full py-3 text-base font-semibold gap-2">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {loading ? "Sending…" : "Send my application"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted">
          Questions? Email{" "}
          <a href="mailto:boulder.regenhub@gmail.com" className="text-sage hover:underline">boulder.regenhub@gmail.com</a>.
        </p>
      </div>
    </div>
  );
}
