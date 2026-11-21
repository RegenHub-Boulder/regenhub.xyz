import Link from "next/link";
import type { PublicMember } from "@/lib/memberDirectory";

/** Initials for a member without a photo: first letters of the first and last word. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? words[words.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

export function MemberPhoto({ member, size }: { member: Pick<PublicMember, "name" | "photoUrl">; size: "sm" | "lg" }) {
  const box = size === "lg" ? "w-28 h-28 text-3xl" : "w-14 h-14 text-lg";
  if (member.photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- member-provided URL or their Techne avatar; Image's optimizer rejects unknown hosts
      <img
        src={member.photoUrl}
        alt=""
        className={`${box} rounded-full object-cover border border-rule shrink-0`}
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <div
      aria-hidden
      className={`${box} rounded-full shrink-0 flex items-center justify-center font-semibold text-sage border border-rule bg-moss/10`}
    >
      {initials(member.name)}
    </div>
  );
}

/** One member in a directory grid, linking to their page. Server- and client-safe (no hooks). */
export function MemberCard({ member }: { member: PublicMember }) {
  return (
    <Link
      href={`/members/${encodeURIComponent(member.slug)}`}
      className="glass-panel-subtle py-4 flex gap-4 items-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-sage"
      data-testid="member-card"
    >
      <MemberPhoto member={member} size="sm" />
      <div className="min-w-0 space-y-1">
        <p className="font-semibold leading-tight break-words">{member.name}</p>
        {member.handle && <p className="text-xs text-muted truncate">@{member.handle}</p>}
        {(member.workingOn ?? member.bio) && (
          <p className="text-sm text-muted leading-relaxed line-clamp-2 break-words">{member.workingOn ?? member.bio}</p>
        )}
        {member.skills.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {member.skills.slice(0, 3).map((s) => (
              <span key={s} className="text-xs px-2 py-0.5 rounded-full border border-rule text-muted max-w-[10rem] truncate">
                {s}
              </span>
            ))}
            {member.skills.length > 3 && <span className="text-xs text-muted px-1">+{member.skills.length - 3}</span>}
          </div>
        )}
      </div>
    </Link>
  );
}
