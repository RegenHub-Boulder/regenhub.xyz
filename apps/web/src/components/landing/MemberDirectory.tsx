"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, User } from "lucide-react";
import type { DirectoryMember } from "@/app/api/members/directory/route";
import { MemberCard } from "@/components/members/MemberCard";

/** How many members the landing page shows before "See all members". */
const LANDING_COUNT = 6;

/** The landing page's slice of the member directory (/members has all of it; lib/memberDirectory.ts says who). */
export function MemberDirectory() {
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`/api/members/directory?limit=${LANDING_COUNT}`)
      .then((r) => r.json())
      .then((d) => {
        setMembers(d.members ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  if (!loaded) {
    return (
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="glass-panel rounded-xl p-5 animate-pulse flex gap-4">
            <div className="w-14 h-14 rounded-full bg-white/10 shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-white/10 rounded w-2/3" />
              <div className="h-3 bg-white/5 rounded w-full" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (members.length === 0) {
    return (
      <div className="glass-panel p-12 text-center">
        <User className="w-10 h-10 text-muted mx-auto mb-4" />
        <p className="text-muted">No members listed yet.</p>
        <p className="text-sm text-muted mt-1">
          Members choose to be listed from their profile.{" "}
          <Link href="/membership" className="text-sage hover:underline">
            About membership
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {members.map((m) => (
          <li key={m.slug}>
            <MemberCard member={m} />
          </li>
        ))}
      </ul>
      <p className="text-center">
        <Link href="/members" className="inline-flex items-center gap-1 text-sage hover:underline">
          See all members <ArrowRight className="w-4 h-4" />
        </Link>
      </p>
    </div>
  );
}
