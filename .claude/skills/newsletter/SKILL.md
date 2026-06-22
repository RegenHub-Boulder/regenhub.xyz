---
name: newsletter
description: Compile the RegenHub community newsletter ("dispatch") as a Markdown draft for admin review. Use when asked to draft/write the newsletter, the biweekly dispatch, or the hub update email. Gathers upcoming Luma events + hub source material, writes in the house voice, and saves a draft the admin reviews and sends from /admin/newsletter.
---

# RegenHub newsletter skill

You are drafting the **RegenHub dispatch** — the community newsletter. Your job is to
produce a finished **Markdown draft**, not to send anything. A human admin reviews and
sends it from the website (`/admin/newsletter`). Never send to the real audience yourself.

Cadence: every other week (open to weekly later). One issue per run.

## 1. Gather material

**Upcoming events (always include).** Pull the real upcoming events from Luma — don't
work from memory. Read `LUMA_API_KEY` from `.env.local`, then:

```bash
KEY=$(grep -E '^LUMA_API_KEY=' .env.local | cut -d= -f2-)
after=$(node -e 'console.log(new Date().toISOString())')
before=$(node -e 'console.log(new Date(Date.now()+28*864e5).toISOString())')
curl -s -H "x-luma-api-key: $KEY" -H "accept: application/json" \
  "https://api.lu.ma/public/v1/calendar/list-events?after=$after&before=$before"
```

Sort by `start_at`, render dates in `America/Denver`. Highlight 3–6 standouts; link to
`lu.ma/regenhub` for the full calendar.

**Hub source material.** Ask the admin for "what's happening at the hub" — recent
happenings, guest speakers, member news, cooperative milestones, anything to share.
(Later this comes from a queryable source set; for now, ask.) Weave their notes into
prose; don't just list them.

## 2. Write it (house style)

- **Voice:** warm, personal, cooperative — a friend writing to the community, not a
  company doing marketing. "We", "you", "the cooperative". Sincere, a little playful.
- **Structure is a starting point, not a mold** — reshape per the content. A typical
  issue: a short opening on the community's energy → a few thematic sections (what
  we've been exploring, guest dialogues, recurring gatherings, membership/cooperative
  news) → upcoming events → a warm CTA to come co-work (free day pass at RegenHub.xyz).
- **Length:** scannable. Short paragraphs, `##`/`###` headings, a few bullet lists.
  Roughly 400–700 words.
- **Markdown only**, using the supported subset: `#`/`##`/`###`, `**bold**`, `*italic*`,
  `[links](url)`, `- bullets`, `---` rules. (The email renderer handles this subset.)
- Don't include a subject line in the body — provide it separately. End with the
  RegenHub sign-off + address; the renderer adds the unsubscribe footer.

## 3. Verify facts (this matters — it goes to ~350 people)

You have the internet — **use it**. Verify proper nouns before publishing: speaker
names + spellings, event/title names, dates, encyclical/book titles, anything
checkable. When in doubt, confirm with the admin rather than guessing or vaguely
hand-waving. (Lesson learned: a real title beats a soft paraphrase.)

## 4. Save the draft

Write the issue to `newsletters/<issue-key>.md` (e.g. `2026-W26`) with frontmatter:

```markdown
---
issue_key: 2026-W26
status: draft
subject: "RegenHub dispatch — <short, specific>"
---

<body markdown>
```

Then tell the admin: paste the subject + body into **`/admin/newsletter`**, hit **Save
draft**, **Email preview to me**, and when it looks right, **Prepare audience** →
**Send**. (Eventually the RegenHub ops MCP will let you save the draft straight to the
DB; until then the admin loads it.)

## House facts (keep current)

- Location: 1515 Walnut St, Suite 200, Boulder, CO. Free day pass at RegenHub.xyz.
- A Limited Cooperative Association, incorporated 2026-02-06.
- Membership starts at $30/mo (incl. 1 co-working day/mo + member channels/events);
  full ladder at /membership.
- Full event calendar + RSVP: lu.ma/regenhub.
