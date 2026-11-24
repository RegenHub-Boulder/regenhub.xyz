# Walkthrough: a stuck door-code writer frees itself (T-482)

What's judged: when a door-code change dies part-way, does the site say so plainly, and does the next change recover on
its own? And does Clear all clear every slot with no "busy"?

**Run it (staging, sample rows, Home Assistant stubbed, never the real locks):**

```bash
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18700 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18704 \
  SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
TECHNE_OAUTH_PRIVATE_JWK="$(node scripts/techne-oauth-key.mjs)" T482_AUDIT=1 T482_STUCK_WRITER=1 T482_HA_STUB=1 \
  T482_PORT_BASE=18700 scripts/staging/preview.sh
PLAYWRIGHT_DIR=<dir with node_modules/playwright> node scripts/staging/writer-lease-shots.mjs http://127.0.0.1:18700 <outdir>
```

Sign in as "RegenHub steward (sample)". The seed has a Web PIN writer that died about three days ago, two door-code
changes that couldn't start behind it, and nine quarantined slots.

1. **Today** (`walkthrough/t482-writer-lease/01-today-*.png`)
   Show: the first line of "Waiting on you", "Door-code writer stuck: held by Web PIN writer since Nov 20…", and "2
   door-code changes failed in the last day".
   Say: "A door-code change that died mid-way used to block every code for days. Now Today says so, first thing."

2. **Door → Lock Sync** (`02-door-stuck-*.png`)
   Show: the red line, "The door-code writer is stuck: Web PIN writer took it at … and stopped. The next door-code
   change takes it over", the two failures, and the quarantined slots below.
   Say: "It says who held it and since when, and that you don't need to do anything special."

3. **Clear all 9** (`03-door-cleared-outcomes-desktop.png`)
   Show: one line per slot, "cleared on every lock and released", for all nine.
   Say: "One click: it took the dead writer over, then cleared the slots one at a time. No 'busy'."

4. **After** (`03-door-cleared-*.png`, `04-today-after-*.png`)
   Show: the stuck line is gone from Lock Sync and from Today.
   Say: "The writer is free again, and Today is back to the real work."
