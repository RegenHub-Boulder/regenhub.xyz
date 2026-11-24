# First visits: who's usually here, "I'm coming", and a hello in the members' chat (T-482)

What's being judged: whether a free-day guest knows what to expect, and whether the members' chat hears early enough to
go say hi. Look at the /freeday page before the code, the two chat messages, and the emails.

Run: `T482_AUDIT=1 T482_FREEDAY=1 T482_PORT_BASE=18760 scripts/staging/preview.sh` (the app built with
`NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18760 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18764`), then
`PLAYWRIGHT_DIR=<dir with playwright> SUPA_URL=http://127.0.0.1:18764 node scripts/staging/first-visit-shots.mjs
http://127.0.0.1:18760 http://127.0.0.1:18767 walkthrough/t482-first-visit`. Sample people only; the chat is a stand-in.

1. **Before the code** (`01-freeday-before-*.png`). Sam is approved. "Who's usually here" comes from eight weeks of door
   entries: "Most weekdays someone's in by 9am; Fridays are quieter." Then getting in and what to bring.
   *Say:* "Sam can see if anyone is likely to be in, and exactly how the door works."
2. **I'm coming tomorrow** (`02-freeday-planned-*.png`). One tap. The page says the members know.
   *Say:* "Saying a day is optional, and any weekday still works."
3. **The chat** (`05-chat-*.png`). "Sam plans to come in tomorrow for their free day." Later, when the door logs Sam's
   first entry: "👋 Sam just came in for their first day (free day). Invited by Ana Sample. Anyone around to say hi?"
   A second entry posts nothing.
   *Say:* "A member can plan to be there, and hears the moment someone new walks in."
4. **The morning email** (`03-morning-email-*.png`), 7 AM on the day they said: the code link, how to get in, who's
   usually here. **The approval email** (`06-approval-email-*.png`) carries the same section.
5. **On the day** (`04-freeday-code-*.png`): under the code, the line and what to bring, then Hub Essentials as before.
