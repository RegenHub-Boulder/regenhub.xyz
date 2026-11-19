"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

interface StaleMember {
  member_id: number;
  email: string | null;
  name: string;
  supabase_user_id: string | null;
  has_did: boolean;
}

export default function StaleLinksPage() {
  const [members, setMembers] = useState<StaleMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  function load() {
    fetch("/api/admin/members/stale-links")
      .then((r) => r.json())
      .then((json) => {
        if (json.error) {
          setError(json.error);
          return;
        }
        setMembers(json.members ?? []);
      })
      .catch(() => setError("Failed to load stale links"));
  }

  useEffect(() => {
    load();
  }, []);

  async function relink(m: StaleMember) {
    if (!confirm(`Relink ${m.name} (${m.email ?? "no email"}) to their current sign-in? This cannot be undone.`)) return;
    setBusyId(m.member_id);
    try {
      const res = await fetch(`/api/admin/members/${m.member_id}/relink-auth`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Relink failed");
      if (json.noop) {
        alert(json.message ?? "Already linked to the current identity");
      } else {
        alert(`Relinked ${m.name} to their current sign-in.`);
        setMembers((prev) => (prev ?? []).filter((x) => x.member_id !== m.member_id));
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Relink failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-forest">Stale Auth Links</h1>
        <p className="text-muted text-sm mt-1">
          Members whose supabase_user_id points at an auth identity that no longer exists (migration 050) —
          usually from a deleted account whose email later moved onto this row. Relinking points them at
          whatever auth.users row their email signs in through today.
        </p>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!members ? (
        <div className="glass-panel-subtle p-8 rounded-xl text-center text-muted">Loading…</div>
      ) : members.length === 0 ? (
        <div className="glass-panel-subtle p-8 rounded-xl text-center text-muted">
          No members have a stale auth link right now.
        </div>
      ) : (
        <div className="glass-panel rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-muted border-b border-white/10">
              <tr>
                <th className="px-4 py-3 font-medium">Member</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">DID</th>
                <th className="px-4 py-3 font-medium">Dead auth id</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.member_id} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-3">
                    <Link href={`/admin/members/${m.member_id}`} className="text-sage hover:underline">
                      #{m.member_id}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-medium">{m.name}</td>
                  <td className="px-4 py-3 text-muted">{m.email ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`glass-panel-subtle px-2 py-0.5 text-xs rounded-full ${
                        m.has_did ? "text-sage" : "text-muted"
                      }`}
                    >
                      {m.has_did ? "Yes" : "No"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted font-mono text-xs">{m.supabase_user_id ?? "—"}</td>
                  <td className="px-4 py-3">
                    <Button
                      size="sm"
                      disabled={busyId === m.member_id}
                      onClick={() => relink(m)}
                      className="btn-primary-glass text-xs"
                    >
                      {busyId === m.member_id ? "Relinking…" : "Relink to current sign-in"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
