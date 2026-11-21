import Link from "next/link";

export type PeopleTab = "applications" | "freedays" | "interests" | "members";

/** Where each People tab lives. Members keeps its own URL (member pages link /admin/members/<id> everywhere). */
export const PEOPLE_TABS: { key: PeopleTab; label: string; href: string }[] = [
  { key: "applications", label: "Applications", href: "/admin/people?tab=applications" },
  { key: "freedays", label: "Free days", href: "/admin/people?tab=freedays" },
  { key: "interests", label: "Interests", href: "/admin/people?tab=interests" },
  { key: "members", label: "Members", href: "/admin/members" },
];

function PendingBadge({ count }: { count?: number }) {
  if (!count || count <= 0) return null;
  return (
    <span className="text-xs bg-warn/10 text-warn border border-warn/40 px-1.5 py-0.5 rounded-full">
      {count}
    </span>
  );
}

/**
 * People: the funnel (applications, free days, interests) and the member list under one heading, as links so each
 * tab reads only its own rows. Styled like AdminTabs. Pending counts badge Applications and Free days when known.
 */
export function PeopleTabs({
  active,
  pending = {},
}: {
  active: PeopleTab;
  pending?: { applications?: number; freedays?: number };
}) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-forest">People</h1>
      <nav aria-label="People" className="flex gap-1 border-b border-rule -mb-px overflow-x-auto">
        {PEOPLE_TABS.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={t.key === active ? "page" : undefined}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap ${
              t.key === active ? "border-sage text-sage" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {t.label}
            <PendingBadge count={t.key === "applications" ? pending.applications : t.key === "freedays" ? pending.freedays : undefined} />
          </Link>
        ))}
      </nav>
    </div>
  );
}
