"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Save, Trash2 } from "lucide-react";
import type { Member } from "@/lib/supabase/types";

interface Props {
  member?: Member;
}

export function MemberForm({ member }: Props) {
  const isEdit = !!member;
  const [form, setForm] = useState({
    name: member?.name ?? "",
    email: member?.email ?? "",
    member_type: member?.member_type ?? "full",
    membership_tier: member?.membership_tier ?? "community",
    is_admin: member?.is_admin ?? false,
    telegram_username: member?.telegram_username ?? "",
    pin_code_slot: member?.pin_code_slot?.toString() ?? "",
    pin_code: member?.pin_code ?? "",
    disabled: member?.disabled ?? false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = e.target.type === "checkbox"
        ? (e.target as HTMLInputElement).checked
        : e.target.value;
      setForm((f) => ({ ...f, [key]: value }));
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const payload = {
      ...form,
      pin_code_slot: form.pin_code_slot ? Number(form.pin_code_slot) : null,
      email: form.email || null,
      telegram_username: form.telegram_username || null,
      pin_code: form.pin_code || null,
    };

    try {
      const url = isEdit
        ? `/api/admin/members/${member!.id}`
        : "/api/admin/members";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      router.push("/admin/members");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!isEdit) return;
    if (!confirm(`Delete ${member!.name}? This cannot be undone.`)) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/members/${member!.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      router.push("/admin/members");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card className="glass-panel">
        <CardContent className="p-6 space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input id="name" value={form.name} onChange={set("name")} required className="glass-input" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={form.email} onChange={set("email")} className="glass-input" />
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="member_type">Member type *</Label>
              <select
                id="member_type"
                value={form.member_type}
                onChange={set("member_type")}
                className="w-full rounded-md px-3 py-2 text-sm glass-input"
              >
                <option value="full">Full</option>
                <option value="daypass">Day pass</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="membership_tier">Tier *</Label>
              <select
                id="membership_tier"
                value={form.membership_tier}
                onChange={set("membership_tier")}
                className="w-full rounded-md px-3 py-2 text-sm glass-input"
              >
                <option value="community">Community</option>
                <option value="coworking">Coworking</option>
                <option value="cooperative">Cooperative</option>
              </select>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="telegram">Telegram username</Label>
              <Input id="telegram" value={form.telegram_username} onChange={set("telegram_username")} placeholder="@handle" className="glass-input" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slot">PIN slot (1–249)</Label>
              <Input id="slot" type="number" min={1} max={249} value={form.pin_code_slot} onChange={set("pin_code_slot")} className="glass-input" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pin_code">PIN code</Label>
            <Input id="pin_code" value={form.pin_code} onChange={set("pin_code")} placeholder="4–8 digits" className="glass-input font-mono" />
            <p className="text-xs text-muted">Leave blank to auto-generate on first login</p>
          </div>

          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={form.is_admin} onChange={set("is_admin")} className="accent-gold" />
              Admin
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={form.disabled} onChange={set("disabled")} className="accent-red-400" />
              Disabled
            </label>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={loading} className="btn-primary-glass gap-2">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {loading ? "Saving…" : isEdit ? "Save changes" : "Add member"}
        </Button>
        {isEdit && (
          <Button
            type="button"
            variant="ghost"
            disabled={loading}
            onClick={handleDelete}
            className="text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </Button>
        )}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </form>
  );
}
