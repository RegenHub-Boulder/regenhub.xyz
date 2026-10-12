import Image from "next/image";
import Link from "next/link";
import { Newsreader, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { fetchUpcomingEvents } from "@/lib/events";
import { formatEventWhen } from "@/components/events/EventList";
import { DAY_PASS_MEMBER_CENTS, DAY_PASS_PUBLIC_CENTS, PLANS } from "@/lib/plans";
import { HUB_ADDRESS, HUB_EMAIL, HUB_TELEGRAM, PUBLIC_NAV } from "@/components/layout/publicNav";
import { HERO_LINE, HERO_SUB, PRIMARY_CTA } from "./copy";

/**
 * Homepage v2 — "B · Co-op broadsheet" from the October 2026 audit.
 * Rendered by app/page.tsx only when NEXT_PUBLIC_HOME_V2 is "true" (default off).
 * Fonts go through next/font (self-hosted at build, same pattern as layout.tsx).
 */
const serif = Newsreader({ subsets: ["latin"], variable: "--v2-serif", display: "swap" });
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--v2-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--v2-mono", display: "swap" });

const PAPER = "#f1ece2";
const INK = "#1d1b17";
const BRICK = "#b8452a";
const GREEN = "#24543a";
const RULE = "rgba(29,27,23,0.85)";

const $ = (cents: number) => `$${cents / 100}`;

const LADDER = [
  { name: "Member + 1 day/mo", price: $(PLANS.member_basic.defaultMonthlyCents), note: "1 coworking day a month, member rate on extra days, members-only events." },
  { name: "Member + 2 days/mo", price: $(PLANS.member_2day.defaultMonthlyCents), note: "2 coworking days a month." },
  { name: "Member + 5 days/mo", price: $(PLANS.member_5day.defaultMonthlyCents), note: "5 coworking days a month." },
  { name: "Hot desk", price: $(PLANS.hot_desk.defaultMonthlyCents), note: "Door code and 24/7 access to any open desk.", featured: true },
  { name: "Cold desk", price: $(PLANS.cold_desk.defaultMonthlyCents), note: "Your own reserved desk, door code and 24/7 access." },
];

const eyebrow = "font-[family-name:var(--v2-mono)] text-[13px] uppercase tracking-[0.12em]";

function Rule() {
  return <hr style={{ borderColor: RULE }} className="border-t-2 my-0" />;
}

export default async function HomeV2() {
  const { events } = await fetchUpcomingEvents(60);
  const upcoming = events.slice(0, 6);

  return (
    <div
      className={`${serif.variable} ${sans.variable} ${mono.variable} min-h-screen font-[family-name:var(--v2-sans)]`}
      style={{ background: PAPER, color: INK }}
    >
      <header className="max-w-7xl mx-auto px-5 md:px-8 pt-5">
        <div className="flex items-center justify-between gap-4 pb-4">
          <Link href="/" className="font-[family-name:var(--v2-serif)] text-2xl font-semibold tracking-tight">
            RegenHub
          </Link>
          <nav aria-label="Main" className="flex items-center gap-x-5 text-[15px]">
            {PUBLIC_NAV.filter((l) => l.href !== "/freeday").map((l) => (
              <Link key={l.href} href={l.href} className="hidden sm:inline py-3 hover:underline underline-offset-4">
                {l.label}
              </Link>
            ))}
            <Link href="/auth/login" className="py-3 px-1 hover:underline underline-offset-4">
              Member sign in
            </Link>
          </nav>
        </div>
        <Rule />
      </header>

      <main>
        {/* Hero */}
        <section className="max-w-7xl mx-auto px-5 md:px-8 pt-8 md:pt-12 pb-10 md:pb-14 grid md:grid-cols-[1.1fr_1fr] gap-8 md:gap-12 items-center">
          <div>
            <p className={eyebrow} style={{ color: GREEN }}>Boulder, Colorado · 1515 Walnut</p>
            <h1 className="font-[family-name:var(--v2-serif)] text-[38px] leading-[1.05] md:text-6xl md:leading-[1.02] font-medium mt-4 tracking-tight">
              {HERO_LINE}
            </h1>
            <p className="mt-5 text-lg leading-relaxed max-w-xl" style={{ color: "#3a372f" }}>{HERO_SUB}</p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              <Link
                href={PRIMARY_CTA.href}
                className="inline-flex items-center justify-center min-h-12 px-7 text-lg font-medium text-white rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ background: BRICK, outlineColor: INK }}
              >
                {PRIMARY_CTA.label}
              </Link>
              <Link href="/membership" className="underline underline-offset-4 py-3 text-[15px]">
                See membership and prices
              </Link>
            </div>
          </div>
          <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl" style={{ outline: `2px solid ${RULE}`, outlineOffset: 0 }}>
            <Image
              src="/regenhubphotos/photo_5663300016759573255_y.jpg"
              alt="A film screening on the RegenHub rooftop at dusk, people seated on chairs facing a projector screen"
              fill
              priority
              sizes="(min-width: 768px) 50vw, 100vw"
              className="object-cover"
            />
          </div>
        </section>

        <Rule />

        {/* Events */}
        <section className="max-w-7xl mx-auto px-5 md:px-8 py-10 md:py-14 grid md:grid-cols-[220px_1fr] gap-4 md:gap-12">
          <div>
            <p className={eyebrow} style={{ color: GREEN }}>On the calendar</p>
            <h2 className="font-[family-name:var(--v2-serif)] text-3xl mt-2 font-medium">Events</h2>
          </div>
          <div>
            {upcoming.length > 0 ? (
              <ul className="divide-y" style={{ borderColor: "rgba(29,27,23,0.25)" }}>
                {upcoming.map((e) => {
                  const inner = (
                    <span className="flex flex-col sm:flex-row sm:items-baseline sm:gap-6 py-4">
                      <span className="font-[family-name:var(--v2-mono)] text-[14px] sm:w-56 shrink-0" style={{ color: GREEN }}>
                        {formatEventWhen(e.startAt)}
                      </span>
                      <span className="font-[family-name:var(--v2-serif)] text-xl">{e.name}</span>
                    </span>
                  );
                  const internal = e.url?.startsWith("/");
                  return (
                    <li key={e.id} className="border-t first:border-t-0" style={{ borderColor: "rgba(29,27,23,0.25)" }}>
                      {e.url ? (
                        internal ? (
                          <Link href={e.url} className="block hover:bg-black/5">{inner}</Link>
                        ) : (
                          <a href={e.url} target="_blank" rel="noopener noreferrer" className="block hover:bg-black/5">{inner}</a>
                        )
                      ) : (
                        inner
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-lg" style={{ color: "#3a372f" }}>
                Nothing is scheduled in the next two months that we can show here. The full calendar is on the events page.
              </p>
            )}
            <p className="mt-5">
              <Link href="/events" className="underline underline-offset-4">Full calendar →</Link>
            </p>
          </div>
        </section>

        <Rule />

        {/* Prices */}
        <section className="max-w-7xl mx-auto px-5 md:px-8 py-10 md:py-14">
          <p className={eyebrow} style={{ color: GREEN }}>Membership</p>
          <h2 className="font-[family-name:var(--v2-serif)] text-3xl md:text-4xl mt-2 font-medium max-w-2xl">
            Pay for the access that fits your week.
          </h2>
          <ol className="mt-8 grid gap-4 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-6">
            <li className="rounded-xl p-5 border-2" style={{ borderColor: RULE }}>
              <p className="font-medium">Day pass</p>
              <p className="font-[family-name:var(--v2-serif)] text-4xl mt-2">{$(DAY_PASS_PUBLIC_CENTS)}</p>
              <p className="text-sm mt-1" style={{ color: "#3a372f" }}>one day · {$(DAY_PASS_MEMBER_CENTS)} for members</p>
            </li>
            {LADDER.map((t) => (
              <li
                key={t.name}
                className="rounded-xl p-5 border-2"
                style={t.featured ? { borderColor: GREEN, background: GREEN, color: "#fff" } : { borderColor: RULE }}
              >
                <p className="font-medium">{t.name}</p>
                <p className="font-[family-name:var(--v2-serif)] text-4xl mt-2">
                  {t.price}<span className="text-base font-[family-name:var(--v2-sans)]"> /mo</span>
                </p>
                <p className="text-sm mt-1" style={{ color: t.featured ? "#e8f0e4" : "#3a372f" }}>{t.note}</p>
              </li>
            ))}
          </ol>
          <p className="mt-6 text-[15px]" style={{ color: "#3a372f" }}>
            Desk plans need a quick approval from us first. <Link href="/membership" className="underline underline-offset-4">Details and sign-up</Link>.
          </p>
        </section>

        <Rule />

        {/* Visit */}
        <section className="max-w-7xl mx-auto px-5 md:px-8 py-10 md:py-14 grid md:grid-cols-2 gap-8 items-center">
          <div className="relative aspect-[4/3] overflow-hidden rounded-2xl" style={{ outline: `2px solid ${RULE}` }}>
            <Image
              src="/regenhubphotos/photo_5086941274224397434_y.jpg"
              alt="A circle of people seated in the RegenHub room at a community gathering"
              fill
              sizes="(min-width: 768px) 50vw, 100vw"
              className="object-cover"
            />
          </div>
          <div>
            <p className={eyebrow} style={{ color: GREEN }}>Visit</p>
            <h2 className="font-[family-name:var(--v2-serif)] text-3xl md:text-4xl mt-2 font-medium">Come try a day.</h2>
            <p className="mt-4 text-lg leading-relaxed" style={{ color: "#3a372f" }}>
              Request a free day, we&apos;ll confirm and send you a door code. Bring your work and say hello.
            </p>
            <p className="mt-4">{HUB_ADDRESS}</p>
            <Link
              href={PRIMARY_CTA.href}
              className="mt-6 inline-flex items-center justify-center min-h-12 px-7 text-lg font-medium text-white rounded-md"
              style={{ background: BRICK }}
            >
              {PRIMARY_CTA.label}
            </Link>
          </div>
        </section>
      </main>

      <footer className="max-w-7xl mx-auto px-5 md:px-8 pb-10">
        <Rule />
        <div className="pt-6 flex flex-wrap gap-x-8 gap-y-2 text-[15px]">
          <a href={`mailto:${HUB_EMAIL}`} className="underline underline-offset-4 py-2">{HUB_EMAIL}</a>
          <a href={HUB_TELEGRAM} className="underline underline-offset-4 py-2">Telegram</a>
          <Link href="/news" className="underline underline-offset-4 py-2">News</Link>
          <Link href="/events" className="underline underline-offset-4 py-2">Events</Link>
        </div>
      </footer>
    </div>
  );
}
