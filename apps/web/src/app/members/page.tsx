import type { Metadata } from "next";
import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/admin";
import { publicDirectory, type PublicMember } from "@/lib/memberDirectory";
import { MemberCard } from "@/components/members/MemberCard";

/**
 * The member directory: members in standing who chose to be listed (lib/memberDirectory.ts), each linking to
 * their page. Public; shows only `PublicMember` fields.
 */

export const metadata: Metadata = {
  title: "Members — RegenHub",
  description: "The members of RegenHub Boulder and what they're working on.",
};

// Rendered per request: a member who opts out or lapses drops out at once.
export const dynamic = "force-dynamic";

export default async function MembersPage() {
  let members: PublicMember[] = [];
  try {
    members = await publicDirectory(createServiceClient());
  } catch (err) {
    console.error("[members] directory read failed:", err);
  }

  return (
    <div className="px-6 py-12">
      <div className="max-w-5xl mx-auto space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold text-forest">Members</h1>
          <p className="text-muted max-w-2xl">
            The people who make RegenHub, and what they&apos;re working on. Members choose whether to be listed here.
          </p>
        </header>

        {members.length > 0 ? (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="member-directory">
            {members.map((m) => (
              <li key={m.slug}>
                <MemberCard member={m} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="glass-panel-subtle rounded-xl p-8 text-center text-muted">No one is listed yet.</p>
        )}

        <p className="text-sm text-muted">
          A member?{" "}
          <Link href="/portal/profile" className="text-sage underline">
            Add yourself from your profile
          </Link>
          . Not yet?{" "}
          <Link href="/membership" className="text-sage underline">
            See membership
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
