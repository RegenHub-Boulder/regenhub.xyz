"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Save } from "lucide-react";

interface Member {
  id: number;
  name: string;
  email: string | null;
  telegram_username: string | null;
  ethereum_address: string | null;
  bio: string | null;
  skills: string[] | null;
  membership_tier: string;
  member_type: string;
}

export function ProfileForm({ member }: { member: Member }) {
  const [form, setForm] = useState({
    name: member.name,
    bio: member.bio ?? "",
    skills: (member.skills ?? []).join(", "),
    telegram_username: member.telegram_username ?? "",
    ethereum_address: member.ethereum_address ?? "",
  });
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
      setSaved(false);
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);

    const skills = form.skills
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const res = await fetch("/api/portal/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          bio: form.bio || null,
          skills: skills.length ? skills : null,
          telegram_username: form.telegram_username || null,
          ethereum_address: form.ethereum_address || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card className="glass-panel">
        <CardContent className="p-6 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={form.name}
              onChange={set("name")}
              required
              className="glass-input"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              value={member.email ?? ""}
              disabled
              className="glass-input opacity-50"
            />
            <p className="text-xs text-muted">Email is managed by your login — contact an admin to change it</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="telegram">Telegram username</Label>
            <Input
              id="telegram"
              value={form.telegram_username}
              onChange={set("telegram_username")}
              placeholder="@handle"
              className="glass-input"
            />
            <p className="text-xs text-muted">Used for Telegram bot commands (/mycode, /newcode, etc.)</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bio">Bio</Label>
            <textarea
              id="bio"
              value={form.bio}
              onChange={set("bio")}
              rows={3}
              placeholder="What are you working on?"
              className="w-full rounded-md px-3 py-2 text-sm glass-input resize-none"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="skills">Skills</Label>
            <Input
              id="skills"
              value={form.skills}
              onChange={set("skills")}
              placeholder="React, Python, Music, Permaculture…"
              className="glass-input"
            />
            <p className="text-xs text-muted">Comma-separated — shown in the member directory</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="eth">Ethereum address</Label>
            <Input
              id="eth"
              value={form.ethereum_address}
              onChange={set("ethereum_address")}
              placeholder="0x…"
              className="glass-input font-mono text-sm"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={loading} className="btn-primary-glass gap-2">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {loading ? "Saving…" : "Save changes"}
        </Button>
        {saved && <span className="text-sm text-sage">Saved!</span>}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </form>
  );
}
