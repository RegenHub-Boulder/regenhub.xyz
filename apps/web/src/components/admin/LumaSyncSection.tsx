import Link from "next/link";
import { ExternalLink, Plus } from "lucide-react";
import { HUB_TIMEZONE } from "@/lib/regenos/eventForm";
import { LUMA_CALENDAR_PAGE, type LumaSync } from "@/lib/lumaCalendar";
import { STEWARD_PATH } from "@/lib/techne/session";

/** How far ahead the check looks: the nights a steward would still list on Luma. */
export const LUMA_SYNC_DAYS = 60;

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: HUB_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * /admin/events, stewards only: whether each upcoming night here is also on RegenHub's Luma calendar, and the
 * Luma nights missing here ("Add here" opens the new-event form prefilled). Read from Luma's public iCal feed
 * (lib/lumaCalendar.ts); `sync` null = the feed couldn't be read. Its own section, beside the calendar form.
 */
export function LumaSyncSection({ sync, now }: { sync: LumaSync | null; now: Date }) {
  const horizon = now.getTime() + LUMA_SYNC_DAYS * 86_400_000;
  const nights = sync?.nights.filter((n) => Date.parse(n.night.startAt) <= horizon) ?? [];
  const lumaOnly = sync?.lumaOnly.filter((e) => Date.parse(e.startAt) <= horizon) ?? [];
  const missing = nights.filter((n) => !n.luma).length;

  return (
    <section className="glass-panel p-5 md:p-6 space-y-4" data-testid="luma-sync" aria-labelledby="luma-sync-title">
      <div>
        <h2 id="luma-sync-title" className="text-lg font-semibold">Also on Luma?</h2>
        <p className="text-xs text-muted mt-1">
          The next {LUMA_SYNC_DAYS} days, checked against{" "}
          <a href={LUMA_CALENDAR_PAGE} target="_blank" rel="noopener noreferrer" className="text-sage hover:underline">
            luma.com/regenhub
          </a>{" "}
          (its public feed, read every 15 minutes). Luma isn&apos;t changed from here.
        </p>
      </div>

      {sync === null ? (
        <p className="text-sm text-danger" role="alert">Couldn&apos;t read Luma&apos;s calendar just now. Reload to try again.</p>
      ) : (
        <>
          {nights.length === 0 ? (
            <p className="text-sm text-muted">No nights posted here in the next {LUMA_SYNC_DAYS} days.</p>
          ) : (
            <div className="space-y-1">
              <p className="text-xs text-muted">
                {missing === 0 ? "Every night here is on Luma." : `${missing} of ${nights.length} not on Luma yet.`}
              </p>
              <ul className="divide-y divide-rule text-sm">
                {nights.map(({ night, luma }) => (
                  <li key={night.uri} className="flex items-center justify-between gap-3 py-2" data-testid="luma-sync-night">
                    <span className="min-w-0">
                      <span className="text-muted tabular-nums">{when(night.startAt)}</span>{" "}
                      <span className="text-foreground">{night.name}</span>
                    </span>
                    {luma ? (
                      <a
                        href={luma.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 inline-flex items-center gap-1 text-xs text-sage hover:underline"
                        title={luma.name === night.name ? undefined : `On Luma as "${luma.name}"`}
                      >
                        On Luma <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span className="shrink-0 text-xs text-gold">Not on Luma</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {lumaOnly.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">Only on Luma</h3>
              <ul className="divide-y divide-rule text-sm">
                {lumaOnly.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 py-2" data-testid="luma-only">
                    <span className="min-w-0">
                      <span className="text-muted tabular-nums">{when(e.startAt)}</span>{" "}
                      <a href={e.url} target="_blank" rel="noopener noreferrer" className="text-foreground hover:underline">
                        {e.name}
                      </a>
                    </span>
                    <Link
                      href={`${STEWARD_PATH}?fromLuma=${encodeURIComponent(e.id)}`}
                      className="shrink-0 inline-flex items-center gap-1 text-xs text-sage hover:underline"
                    >
                      <Plus className="w-3 h-3" /> Add here
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
