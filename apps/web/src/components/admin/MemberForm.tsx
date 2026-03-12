"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Eye, EyeOff, Loader2, Save, Trash2 } from "lucide-react";
import type { Member } from "@/lib/supabase/types";

interface Props {
  member?: Member;
  initialEmail?: string;
  initialUserId?: string;
}

export function MemberForm({ member, initialEmail, initialUserId }: Props) {
  const isEdit = !!member;
  const [form, setForm] = useState({
    name: member?.name ?? "",
    email: member?.email ?? initialEmail ?? "",
    member_type: member?.member_type ?? "cold_desk",
    is_coop_member: member?.is_coop_member ?? false,
    is_admin: member?.is_admin ?? false,
    telegram_username: member?.telegram_username ?? "",
    pin_code: member?.pin_code ?? "",
    disabled: member?.disabled ?? false,
    initial_day_passes: "10",
  });
  const [loading, setLoading] = useState(false);
  const [showPin, setShowPin] = useState(false);
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

    const payload: Record<string, unknown> = {
      ...form,
      email: form.email || null,
      telegram_username: form.telegram_username || null,
      pin_code: form.pin_code || null,
    };
    if (!isEdit && initialUserId) {
      payload.supabase_user_id = initialUserId;
    }

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
    if (!confirm(`Delete ${member!.name}? This will also clear their door code. This cannot be undone.`)) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/members/${member!.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Delete failed");
      if (json.lock_warning) {
        alert(`Member deleted, but: ${json.lock_warning}`);
      }
      router.push("/admin/members");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setLoading(false);
    }
  }

  const isDayPass = form.member_type === "day_pass";

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
              <Label htmlFor="member_type">Coworking membership *</Label>
              <select
                id="member_type"
                value={form.member_type}
                onChange={set("member_type")}
                className="w-full rounded-md px-3 py-2 text-sm glass-input"
              >
                <option value="cold_desk">Cold Desk</option>
                <option value="hot_desk">Hot Desk</option>
                <option value="hub_friend">Hub Friend</option>
                <option value="day_pass">Day Pass</option>
              </select>
              <p className="text-xs text-muted">
                {form.member_type === "cold_desk" && "Dedicated desk — permanent PIN, full access"}
                {form.member_type === "hot_desk" && "Flexible desk — permanent PIN, full access"}
                {form.member_type === "hub_friend" && "Community friend — permanent PIN, no desk membership"}
                {form.member_type === "day_pass" && "Drop-in — access via day pass pool, no permanent PIN"}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="telegram">Telegram username</Label>
              <Input id="telegram" value={form.telegram_username} onChange={set("telegram_username")} placeholder="@handle" className="glass-input" />
            </div>
          </div>

          {!isDayPass && (
            <div className="space-y-2">
              <Label htmlFor="pin_code">PIN code</Label>
              <div className="relative">
                <Input
                  id="pin_code"
                  type={showPin ? "text" : "password"}
                  value={form.pin_code}
                  onChange={set("pin_code")}
                  placeholder="Leave blank to auto-generate"
                  className="glass-input font-mono pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPin((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground p-1"
                  aria-label={showPin ? "Hide PIN" : "Reveal PIN"}
                >
                  {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {isEdit && member?.pin_code_slot && (
                <p className="text-xs text-muted">Slot {member.pin_code_slot}</p>
              )}
            </div>
          )}

          {!isEdit && (
            <div className="space-y-2">
              <Label htmlFor="initial_day_passes">Initial day passes</Label>
              <Input
                id="initial_day_passes"
                type="number"
                min="0"
                value={form.initial_day_passes}
                onChange={set("initial_day_passes")}
                className="glass-input w-32"
              />
              <p className="text-xs text-muted">Starting balance for generating live door codes</p>
            </div>
          )}

          <div className="flex gap-6 flex-wrap">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={form.is_coop_member} onChange={set("is_coop_member")} className="accent-gold" />
              Co-op member
            </label>
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
