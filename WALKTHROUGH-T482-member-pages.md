# Walkthrough: member pages and the member directory (T-482)

**How to run:** a local preview with sample people only (no production data, no production Techne). Build this
branch with `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18790 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18794
NEXT_PUBLIC_SUPABASE_ANON_KEY=staging pnpm --filter web build`, then `scripts/staging/member-pages-preview.sh`
(Techne and Supabase stand-ins, the real migration 065, sample members). Screens:
`PLAYWRIGHT_DIR=<dir with playwright> node scripts/staging/member-pages-shots.mjs http://127.0.0.1:18790`
(asserts each step) → `walkthrough/member-pages/`, desktop and phone.

What's judged: who shows up, what a member page says, and how a member opts in.

1. **/members** (`01-directory-desktop.png`, `01-directory-phone.png`)
   "The member directory. Only members who said yes are here. Quinn, on an old twenty-dollar plan, and Kit, who
   lapsed, opted in too, but they're not members now, so they're not shown."
2. **Ana's page** (`02-member-page-*.png`)
   "Ana's page is at her Techne handle. Her photo is her Techne avatar. Then what she's working on, skills, links,
   and the nights she came to. Her RSVP for next week's night isn't shown: a public page never says where someone
   will be."
3. **Editing it** (`03-profile-opt-in-*.png`)
   "Ana edits all of this on her profile. One box puts her in the directory; one shows her nights. Email, plan and
   door code are never on the page."
4. **Asked once, at the end of joining** (`04-portal-ask-desktop.png`, `05-portal-ask-yes-desktop.png`)
   "Robin hasn't decided yet. Saving the profile for something else doesn't count as a no, so the portal asks.
   Yes, and Robin is listed."
5. **/membership** (`06-membership-desktop.png`, `04-membership-phone.png`)
   "On the membership page, the member page isn't coming soon any more. It links to the directory."
