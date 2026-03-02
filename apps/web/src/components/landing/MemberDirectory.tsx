"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { User } from "lucide-react";
import type { DirectoryMember } from "@/app/api/members/directory/route";

export function MemberDirectory() {
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/members/directory")
      .then((r) => r.json())
      .then((d) => {
        setMembers(d.members ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  if (!loaded) {
    return (
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {[1, 2, 3].map((i) => (
          <Card key={i} className="glass-panel animate-pulse">
            <CardContent className="p-6">
              <div className="w-12 h-12 rounded-full bg-white/10 mb-4" />
              <div className="h-4 bg-white/10 rounded mb-2 w-2/3" />
              <div className="h-3 bg-white/5 rounded w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (members.length === 0) {
    return (
      <div className="glass-panel p-12 text-center">
        <User className="w-10 h-10 text-muted mx-auto mb-4" />
        <p className="text-muted">Member directory coming soon.</p>
        <p className="text-sm text-muted mt-1">Be the first to apply and shape the community!</p>
      </div>
    );
  }

  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {members.map((m) => (
        <Card key={m.name} className="glass-panel hover-lift">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-3">
              {m.profile_photo_url ? (
                <img
                  src={m.profile_photo_url}
                  alt={m.name}
                  className="w-10 h-10 rounded-full object-cover"
                />
              ) : (
                <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(45,90,61,0.25)" }}>
                  <User className="w-5 h-5 text-sage" />
                </div>
              )}
              <div>
                <p className="font-semibold text-sm">{m.name}</p>
                <p className="text-xs text-muted capitalize">{m.membership_tier.replace("_", " ")} Member</p>
              </div>
            </div>
            {m.bio && (
              <p className="text-sm text-muted leading-relaxed line-clamp-3 mb-3">{m.bio}</p>
            )}
            {m.skills && m.skills.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {m.skills.slice(0, 4).map((s) => (
                  <span
                    key={s}
                    className="text-xs px-2 py-0.5 rounded-full border border-white/10 text-muted"
                  >
                    {s}
                  </span>
                ))}
                {m.skills.length > 4 && (
                  <span className="text-xs text-muted px-1">+{m.skills.length - 4}</span>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
