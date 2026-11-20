import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { ArrowLeft, CalendarDays, Link2 } from "lucide-react";
import { createServiceClient } from "@/lib/supabase/admin";
import { findMemberPage } from "@/lib/memberDirectory";
import { fetchRecentNights } from "@/lib/memberNights";
import { MemberPhoto } from "@/components/members/MemberCard";

/**
 * A member's page: /members/<techne-handle>, or /members/<id> for a member without a Techne link (a linked member
 * reached by id is sent to their handle). Only listed members have one; for anyone else this is the same plain 404.
 */

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

const lookup = cache(async (slug: string) => {
  try {
    return await findMemberPage(createServiceClient(), slug);
  } catch (err) {
    console.error("[members] page lookup failed:", err);
    return { kind: "none" } as const;
  }
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const found = await lookup((await params).slug);
  if (found.kind !== "found") return { title: "Members — RegenHub" };
  const m = found.member;
  return { title: `${m.name} — RegenHub`, description: m.workingOn ?? m.bio ?? `${m.name} is a member of RegenHub Boulder.` };
}

const nightDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Denver" });

export default async function MemberPage({ params }: PageProps) {
  const found = await lookup((await params).slug);
  if (found.kind === "redirect") permanentRedirect(`/members/${encodeURIComponent(found.slug)}`);
  if (found.kind !== "found") notFound();
  const m = found.member;
  const nights = found.showRsvps && found.did ? await fetchRecentNights(found.did) : null;

  return (
    <div className="px-6 py-12">
      <article className="max-w-3xl mx-auto space-y-8" data-testid="member-page">
        <Link href="/members" className="inline-flex items-center gap-1 text-sm text-muted hover:text-sage">
          <ArrowLeft className="w-4 h-4" /> All members
        </Link>

        <header className="flex flex-col sm:flex-row sm:items-center gap-5">
          <MemberPhoto member={m} size="lg" />
          <div className="min-w-0 space-y-1">
            <h1 className="text-3xl md:text-4xl font-bold text-forest break-words">{m.name}</h1>
            {m.handle && <p className="text-muted break-all">@{m.handle}</p>}
          </div>
        </header>

        {m.workingOn && (
          <p className="text-xl md:text-2xl leading-snug border-l-2 border-sage pl-4 break-words" data-testid="member-working-on">
            {m.workingOn}
          </p>
        )}

        {m.bio && <p className="text-muted leading-relaxed whitespace-pre-line break-words">{m.bio}</p>}

        {m.skills.length > 0 && (
          <section className="space-y-2" aria-labelledby="skills">
            <h2 id="skills" className="text-sm uppercase tracking-wider text-sage">
              Skills
            </h2>
            <ul className="flex flex-wrap gap-2">
              {m.skills.map((s) => (
                <li key={s} className="text-sm px-3 py-1 rounded-full border border-white/15 break-all">
                  {s}
                </li>
              ))}
            </ul>
          </section>
        )}

        {m.links.length > 0 && (
          <section className="space-y-2" aria-labelledby="links">
            <h2 id="links" className="text-sm uppercase tracking-wider text-sage">
              Links
            </h2>
            <ul className="space-y-1">
              {m.links.map((l) => (
                <li key={l.url}>
                  <a
                    href={l.url}
                    rel="me nofollow noopener noreferrer"
                    target="_blank"
                    className="inline-flex items-center gap-2 text-sage underline break-all"
                  >
                    <Link2 className="w-4 h-4 shrink-0" />
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {nights && nights.length > 0 && (
          <section className="space-y-2" aria-labelledby="nights" data-testid="member-nights">
            <h2 id="nights" className="text-sm uppercase tracking-wider text-sage">
              Recent nights at the hub
            </h2>
            <ul className="space-y-1">
              {nights.map((n) => (
                <li key={`${n.startAt}-${n.name}`} className="flex items-center gap-2 text-sm">
                  <CalendarDays className="w-4 h-4 text-sage shrink-0" />
                  {n.url ? (
                    <Link href={n.url} className="underline hover:text-sage">
                      {n.name}
                    </Link>
                  ) : (
                    <span>{n.name}</span>
                  )}
                  <span className="text-muted">· {nightDate(n.startAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="text-sm text-muted border-t border-white/10 pt-6">
          {m.name.split(" ")[0]} is a member of RegenHub Boulder.{" "}
          <Link href="/membership" className="text-sage underline">
            About membership
          </Link>
        </p>
      </article>
    </div>
  );
}
