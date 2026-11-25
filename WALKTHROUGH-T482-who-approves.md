# Walkthrough: who approves (T-482, migration 074)

Aaron, 11-24: "any member in the core group (telegram) can approve… on the website, they need to be a co-op member."
Then: "co-op members should be able to approve folks for hot desks."

What is being judged: who can tap Approve where, and whether the pages say who approved.

## Run it

```bash
# one build, pointed at the staging stand-ins (B = 18790)
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18790 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18794 \
  SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
T482_STATE=/tmp/t482y T482_PORT_BASE=18790 T482_AUDIT=1 T482_JOIN=1 T482_WHO=1 scripts/staging/preview.sh
PLAYWRIGHT_DIR=<dir with node_modules/playwright> node scripts/staging/who-approves-shots.mjs \
  http://127.0.0.1:18790 walkthrough/t482-who-approves
```

Sample data: the steward is a site admin but not a co-op member; Ana is a co-op member but not an admin. Kai was
vouched for in the chat by @river, whose Telegram isn't linked to a member.

## Steps

1. **The chat card** (`walkthrough/t482-who-approves/01-chat-cards.png`).
   "In the members' chat, anyone can approve. The card says so. Someone whose Telegram isn't linked shows up by
   their @username."
2. **Ana's portal** (`02-coop-portal.png`).
   "Ana is a co-op member, not an admin. Her menu now has Approvals."
3. **People → Applications as Ana** (`03-coop-apps.png`).
   "She sees the two tabs with decisions in them. Kai shows '@river in the chat vouched', and she can approve."
4. **Free days as Ana** (`04-coop-freedays.png`).
   "A free day approved in the chat reads 'Approved by @sky in the chat'."
5. **The same page as the steward** (`05-admin-apps.png`).
   "A site admin who isn't a co-op member still sees the lists. Where the buttons were, it says 'Co-op members
   approve', and the server refuses too."
6. **Desk access on a member page** (`06-admin-member.png`).
   "Turning desk access on is also a co-op member's job now. It stays on the website, because a desk comes with a
   24/7 door code."
