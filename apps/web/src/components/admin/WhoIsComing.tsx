"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { namesText, type ComingPerson } from "@/lib/whoIsComing";

const TZ = "America/Denver";

function rsvpWhen(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * A night's "N going" on /admin/events, opening to who is coming (lib/whoIsComing.ts): members first, then guests,
 * each with their handle, plan or "Guest", when they RSVP'd, and an email only when the server sent one (site
 * admins). "Copy names" copies names and handles, never emails.
 */
export function WhoIsComing({ going, who }: { going: number | null; who: ComingPerson[] | null }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  if (who === null) {
    return (
      <p className="text-sm text-muted mt-1" data-testid="who-failed">
        {typeof going === "number" ? `${going} going · ` : ""}
        <span className="text-warn">Couldn&apos;t load who&apos;s coming.</span>
      </p>
    );
  }
  if (who.length === 0) return <p className="text-sm text-muted mt-1">No RSVPs yet</p>;
  const members = who.filter((p) => p.kind === "member").length;
  return (
    <details className="mt-1 group" data-testid="who-is-coming">
      <summary className="text-sm text-muted cursor-pointer select-none hover:text-foreground w-fit">
        {who.length} going
        {members > 0 && ` (${members} ${members === 1 ? "member" : "members"})`}
        <span className="text-sage"> · Who&apos;s coming</span>
      </summary>
      <div className="mt-2 border-t border-rule pt-2 space-y-2">
        <ul className="divide-y divide-rule">
          {who.map((p) => (
            <li key={p.did} className="py-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
              <span className="font-medium text-foreground">{p.name}</span>
              {p.handle && p.name !== `@${p.handle}` && <span className="text-muted">@{p.handle}</span>}
              <Badge>{p.kind === "member" ? "Member" : "Guest"}</Badge>
              {p.plan && <span className="text-muted">{p.plan}</span>}
              {p.email && (
                <a href={`mailto:${p.email}`} className="text-muted hover:text-foreground break-all" data-testid="who-email">
                  {p.email}
                </a>
              )}
              {p.rsvpAt && <span className="text-xs text-muted sm:ml-auto">RSVP&apos;d {rsvpWhen(p.rsvpAt)}</span>}
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              // No clipboard outside a secure context (a plain-http preview): say so rather than fail silently.
              if (!navigator.clipboard) return setCopy("failed");
              navigator.clipboard.writeText(namesText(who)).then(() => setCopy("copied"), () => setCopy("failed"));
            }}
            className="text-xs px-2 py-1 rounded btn-glass"
          >
            {copy === "copied" ? "Copied" : "Copy names"}
          </button>
          {copy === "failed" && <span className="text-xs text-warn">This browser blocked copying.</span>}
        </div>
      </div>
    </details>
  );
}
