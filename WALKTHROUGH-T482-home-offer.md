# T-482: the home page says what RegenHub offers now

What's being judged: the new order and the new words on `/` (list below, all **draft for Aaron**), and that
the nights on `/` are the ones on `/events`.

## Run it

Staging preview, sample data only (the Techne stand-in's nights: Agents Building Night Dec 1, 420 Happy Hour Dec 4):

```bash
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18790 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18794 \
  SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
T482_STATE=$TMPDIR/t482home T482_BUILD=$HOME/.cache/t482 T482_PORT_BASE=18790 bash scripts/staging/preview.sh
PLAYWRIGHT_DIR=<dir with playwright> node scripts/staging/home-offer-shots.mjs http://127.0.0.1:18790 after
```

Open http://127.0.0.1:18790/.

## Steps

1. **Before** (`walkthrough/home-offer/before-desktop-full.png`). "Boulder's regenerative coworking space", four
   pillars with economic democracy and equity, and Upcoming Events saying "Nothing else on the calendar yet" while
   /events lists Dec 1 and Dec 4.
   *Say:* "The old home sold things we no longer say, and its events section came up empty."
2. **The top** (`after-desktop-top.png`, `after-phone-top.png`). "A co-op of builders in Boulder", Tuesdays open to
   everyone, two actions: Come to a Tuesday, Try a free day.
   *Say:* "Who we are in one line, and the two ways to come by."
3. **Coming up** (`after-desktop-full.png`, second section). The next nights from our own calendar, one line each,
   linked to each night's page. Same nights as `/events` (`after-events-page.png`).
   *Say:* "The nights now come from the same calendar as the events page."
4. **Membership** (same shot). From $30 a month, the three plans with their days, what every plan includes, Apply.
   Day pass, desks and the free day sit below it, smaller.
   *Say:* "Membership is the main offer; the day pass and desks are add-ons."
5. **The rest.** Members, one line about the co-op, photos ("At the hub", no autoplay), Find us, Stay in touch at
   the foot.
6. **Worst cases** (`break-many-phone.png`, `break-none-phone.png`). Twelve nights with long names: five show, long
   words wrap. No nights: the Tuesday rhythm and a link to all events, never "nothing on the calendar".

## New copy (draft for Aaron)

Reused words are marked *(from /membership)* or *(from /events)*; everything else is new. Prices come from
`lib/plans.ts`.

1. Page title: "RegenHub Boulder — a co-op of builders"
2. Share line: "A co-op of builders in Boulder. Techne Tuesdays are open to everyone; membership from $30 a month."
   (the description adds "Your first day is free.")
3. Heading: "A co-op of builders in Boulder"
4. Under it: "Techne Tuesdays are free and open to everyone. Members show their work and help each other with it.
   Your first day is free." *(from /membership and the old hero)*
5. Buttons: "Come to a Tuesday", "Try a free day" *(from the brief)*
6. "Coming up"; "All events"; with no nights: "Techne Tuesdays: Agents Building Night on the 1st, Boulder
   Blockchain Meetup on the 2nd, Civic Tech Night on the 3rd. The dates are on the events page." *(rhythm from
   /events)*; while loading: "See the nights on the events page →"
7. "Membership, from $30 a month" / "Membership gets you into the rooms where members show their work and help each
   other with it." *(from /membership)*
8. Plan rows: "$30 a month · 1 coworking day a month", "$50 … 2 coworking days", "$100 … 5 coworking days"
9. "Every plan includes": Member demos (the Friday demos before 420 Happy Hour, and first claim on demo slots at
   Techne Tuesdays); Studio Night (hang out with other members and get help with your agent, your data, your tools);
   Your member page (a page of your own and a place in the member directory); "Unused days carry over. Extra day
   passes are $25 for members instead of $30." *(from /membership's "What members get")*
10. "Apply to join", "More about membership →"
11. "Or come by the day": Free day, "Your first day is on us. Pick a date and we'll send you a door code."; Day pass,
    "$30 a day, $25 for members", "Monday to Friday, 8 AM to 6 PM, no contract."; Desks, "Hot desk $250 · cold desk
    $500 a month", "A permanent door code and 24/7 access."
12. "Members" / "Some of the people who work here."
13. The co-op line, in place of the four pillars: "RegenHub is a cooperative workspace in downtown Boulder. Its
    members and stewards host the nights, and the open ones are open to everyone."
14. Photos heading: "At the hub" (was "Community Moments" / "Glimpses of our vibrant community in action")
15. "Stay in touch" / "Leave your email and we'll write when there's something on."

On staging the Members section reads "No members listed yet." because the stand-in has no opted-in members; in
production it shows the existing cards.
