# T-482 walkthrough: the two nights, feeds and RSVP with Techne (staging, sample data)

**What's judged:** whether `/` and `/events` lead clearly with Agents Night and Civic Tech Night, whether the series
pages say enough, whether anything still promises a repeating schedule (it shouldn't), and whether "Sign in with Techne" → "I'm going" feels simple enough for a first-time guest.

## Run it
- Staging: `https://uni.taildf9ce2.ts.net:8590` once Uni runs the one serve command (see the report); on uni itself
  `http://127.0.0.1:18590` now. Unit: `systemctl --user status t482-staging` (transient; recipe
  `scripts/staging/preview.sh`). A restart starts clean: new collective, the first night of each series, sample
  people Ana, Jo, Sam, Lee (fictional), 2 RSVPs on Agents Night and 1 on Civic Tech Night.
- No real member data anywhere: local Techne AppView + local Postgres; no Supabase runs, so the member portal shows
  its signed-out state.
- Video: removed (its narration described the old repeating schedule). `walkthrough/film.py` has the updated script;
  remake after a fresh staging restart with `~/Code/unforced-media/video-lab/.venv/bin/python walkthrough/film.py capture`
  then `… render` (needs the Kokoro voice cache, which this run's sandbox couldn't read).

## Steps
1. **Home** (`01-home-mobile.png`, `05-home-desktop.png`): right under the hero, "Come to a night" with the two
   cards and their next dates. *"The home page now leads with the two community nights."*
2. **Events** (`02`, `06`): the community nights first, then anything else on the calendar, and the calendar feed.
   *"Agents Night and Civic Tech Night come first, each with its next date."*
3. **Series page** (`03`, `07`; Civic `04`, `08`): what the night is, the next posted night, and "Add Agents Night
   to your calendar" (`/events/agents-night.ics`). *"One link adds the series to your calendar and keeps it up to
   date."* With no night posted (`12-series-coming-soon.png`, Techne unreachable) the
   page says "Next date coming soon". *"No schedule is promised: only posted nights show."*
4. **A night's page, signed out** (`09-night-signed-out.png`): RSVP card with the count and "Sign in with Techne".
   *"RSVP starts with Sign in with Techne, the way the Techne docs describe it."*
5. **Sign in** (`10-sign-in.png`): on staging a stand-in plays techne.town's sign-in; pick "Lee (sample)".
   *"On staging, a stand-in plays the sign-in screen."*
6. **Going** (`11-night-going.png`): "I'm going" → "3 going · You're going", and the line showing the event is a
   Techne record. *"That writes Lee's own RSVP record, and the count goes up."*

Listen for: the spelled "R S V P" and "Techne" in the voice (Whisper didn't hear them back; nobody has listened yet).
