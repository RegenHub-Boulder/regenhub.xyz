import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isStylePreviewEnabled } from "@/lib/stylePreview";
import { DIRECTION_CARDS, RECOMMENDATION, REFERENCES } from "@/lib/styleDirections";
import { getSeries } from "@/lib/series";
import { fetchCollectiveEvents } from "@/lib/regenos/events";
import { overviewFor } from "@/lib/seriesEvents";

/**
 * STAGING ONLY (T-482): the picker. The three visual directions side by side, each with its case, its tokens and
 * screenshots of the real pages, and links that open the live site in that look. 404 unless the preview switch is
 * on (lib/stylePreview.ts). This page itself never takes a direction (the switch script skips it).
 */

export const metadata: Metadata = { title: "Three looks — RegenHub (staging)", robots: { index: false } };
export const dynamic = "force-dynamic";

/** The next Agents Building Night's own page (the one in the screenshots), or the series page if none is posted. */
async function agentsNightHref(): Promise<string> {
  const series = getSeries("agents-night");
  if (!series) return "/events";
  const now = new Date();
  const events = (await fetchCollectiveEvents({ after: now.toISOString() })) ?? [];
  return overviewFor(series, events, now).next?.url ?? `/events/${series.slug}`;
}

const shot = (style: string, file: string) => `/style-preview/shots/${style}/${file}`;
const withStyle = (href: string, style: string) => `${href}${href.includes("?") ? "&" : "?"}style=${style}`;

export default async function StylePreviewPage() {
  if (!isStylePreviewEnabled()) notFound();
  const pages = [
    ["Home", "/"],
    ["Agents Building Night", await agentsNightHref()],
    ["Membership", "/membership"],
    ["Members", "/members"],
    ["Portal", "/portal"],
  ] as const;

  return (
    <div className="min-h-screen bg-[#f3f2ed] text-[#1d1d1b] font-sans" data-testid="style-picker">
      <div className="max-w-[88rem] mx-auto px-5 py-8 space-y-8">
        <header className="max-w-3xl space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">Three looks for regenhub.xyz</h1>
          <p className="text-[#4a4a45] leading-relaxed">
            The same real pages (home, an event night, membership, the member directory and the portal), with the
            same words and structure, in three visual directions. Judge the feel: type, colour, room, imagery and how
            the page arrives. The words and what each page offers are unchanged on purpose.
          </p>
          <p className="text-sm text-[#4a4a45]">
            Each link below opens the live staging site in that look and remembers it while you click around.{" "}
            {/* A full page load on purpose: the switch runs before first paint, not on client navigation. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a className="underline" href="/?style=off">
              See today&apos;s look
            </a>
            .
          </p>
          <div className="rounded-md bg-white border border-[#d9d7ce] p-4" data-testid="style-recommendation">
            <p className="font-semibold mb-1">Recommendation</p>
            <p className="text-sm leading-relaxed text-[#33332f]">{RECOMMENDATION}</p>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-3">
          {DIRECTION_CARDS.map((d) => (
            <section
              key={d.key}
              className="rounded-md bg-white border border-[#d9d7ce] p-5 space-y-5"
              data-testid={`direction-${d.key}`}
            >
              <div className="space-y-1">
                <h2 className="text-xl font-semibold">{d.name}</h2>
                <p className="text-sm leading-relaxed text-[#4a4a45]">{d.idea}</p>
              </div>

              <a href={withStyle("/", d.key)} className="block" aria-label={`Open the home page in ${d.name}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- staging screenshots from a gated route */}
                <img
                  src={shot(d.key, "01-home-desktop.png")}
                  alt={`Home page, desktop, in ${d.name}`}
                  className="w-full rounded border border-[#e3e1d8]"
                  loading="lazy"
                />
              </a>
              <div className="grid grid-cols-2 gap-3">
                {(["01-home-phone.png", "02-event-night-phone.png"] as const).map((f) => (
                  <a key={f} href={shot(d.key, f)}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- staging screenshots from a gated route */}
                    <img
                      src={shot(d.key, f)}
                      alt={`${f.includes("home") ? "Home" : "Event night"}, phone, in ${d.name}`}
                      className="w-full rounded border border-[#e3e1d8] aspect-[390/844] object-cover object-top"
                      loading="lazy"
                    />
                  </a>
                ))}
              </div>

              <p className="text-sm">
                <span className="text-[#4a4a45]">Open live: </span>
                {pages.map(([label, href], i) => (
                  <span key={href}>
                    {i > 0 && ", "}
                    <a className="underline" href={withStyle(href, d.key)}>
                      {label}
                    </a>
                  </span>
                ))}
              </p>

              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Type</h3>
                {d.type.map((t) => (
                  <div key={t.role}>
                    <p
                      style={{ fontFamily: t.css, fontSize: t.size, fontStyle: t.style, fontWeight: t.weight }}
                      className="leading-tight"
                    >
                      {t.sample}
                    </p>
                    <p className="text-xs text-[#6a6a63]">
                      {t.role}: {t.family}
                    </p>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Colour</h3>
                <ul className="flex flex-wrap gap-3">
                  {d.palette.map((c) => (
                    <li key={c.hex} className="flex items-center gap-2 text-xs">
                      <span className="w-6 h-6 rounded-full border border-[#d9d7ce]" style={{ background: c.hex }} />
                      <span>
                        {c.name} <span className="text-[#6a6a63]">{c.hex}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-1">
                <h3 className="text-sm font-semibold">Each choice, and the taste it answers</h3>
                <ul className="text-sm space-y-1 leading-snug">
                  {d.choices.map((c) => (
                    <li key={c.choice}>
                      {c.choice} <span className="text-[#6a6a63]">({c.because})</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-1 text-sm leading-relaxed">
                <p>
                  <span className="font-semibold">Room: </span>
                  {d.spacing}
                </p>
                <p>
                  <span className="font-semibold">Motion: </span>
                  {d.motion}
                </p>
                <p>
                  <span className="font-semibold">Strong: </span>
                  {d.strong}
                </p>
                <p>
                  <span className="font-semibold">Risk: </span>
                  {d.risk}
                </p>
                <p className="text-[#6a6a63]">Learned from {d.learnedFrom}.</p>
              </div>
            </section>
          ))}
        </div>

        <section className="max-w-3xl space-y-2">
          <h2 className="text-lg font-semibold">What the three learned from</h2>
          <ul className="text-sm space-y-1.5 leading-snug">
            {REFERENCES.map((r) => (
              <li key={r.url}>
                <a className="underline" href={r.url} target="_blank" rel="noopener noreferrer">
                  {r.name}
                </a>{" "}
                <span className="text-[#4a4a45]">
                  {r.note} <span className="text-[#6a6a63]">({r.informs})</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
