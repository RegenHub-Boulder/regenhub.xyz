# Sign in with Techne on regenhub.xyz (T-482, part 2)

One door: "Sign in with Techne" is the site's sign-in. The same session RSVPs, posts RegenHub's calendar, and (part 3,
"One door" below) opens the member portal when the Techne account is linked to a member. The Supabase email link
stays as a quiet fallback ("Use an email link instead"). Written 2026-11-17 from the
public docs only (techne.computer/llms.txt and what it lists, reference.html, techne.pub, the lexicons in npm
`techne-sdk@0.4.0`) and read-only calls to the live platform.

## What changed

- With `TECHNE_SIGNIN_ENABLED` **off** Manage Events is exactly as before T-482: the old
  regenOS-lane page at `/portal/events` (`components/portal/legacy/`, main's code unchanged, Import from Luma
  included), its nav link and dashboard card, and the revalidate route, all on `REGENOS_LOGIN_ENABLED`
  (`isStewardEventsEnabled`, `lib/techne/config.ts`).
- With it **on**, the stewards' page is `/admin/events` (`/portal/events` redirects there; gated by the Techne role, not a site membership, since 11-19): the same server-held session as RSVP (one door, below). The old page stays reachable at `/portal/events/old` while the regenOS lane is on (nothing links to it), until
  Aaron retires it.
- The calendar on that page is the documented public read every visitor gets, plus each event's config and
  listing (`query.getRecords`), so edits keep them and removal deletes exactly what exists.
- **Everyone signed in with Techne gets the posting form.** RegenHub's public membership claims only word a hint
  (the person's role, or "Posting works if you manage RegenHub on Techne"). Techne decides on the write.
- Posting, editing and removing write **as the collective**: the event, its config and its listing in RegenHub's
  repo, in one standard `com.atproto.repo.applyWrites` sent **straight to the steward's own PDS, with no
  `atproto-proxy` header** (`lib/techne/collectiveEvents.ts`, `lib/techne/collectiveWrite.ts`).
- `TECHNE_RSVP_ENABLED` is renamed `TECHNE_SIGNIN_ENABLED` (it now covers both pages). Production has it **on** today (PR #121's browser client: RSVP and the Techne Manage Events page are live).

## One door (T-482 part 3, 2026-11-17; server-side client after the PR #122 review)

Aaron, 11-17: "When I just go to portal I'm still getting old scenius login. It should feel unified."

**regenhub.xyz is the OAuth client, on the server.** The review of PR #122 (H1) found that the first version, a
browser client proving itself with atproto service auth, let any app or app password a member had granted broadly
(`transition:generic`, which pds.techne.town supports) open that member's portal, and an admin's admin area. Uni's
decision: fix the cause. Now:

- `@atproto/oauth-client-node` (`lib/techne/oauth/client.ts`) is a **confidential client**: PAR, PKCE, DPoP, and a
  `private_key_jwt` client assertion signed with `TECHNE_OAUTH_PRIVATE_JWK` (ES256, with a `kid`; make one with
  `node scripts/techne-oauth-key.mjs`, set it in Coolify, never commit it). The metadata
  (`/techne/client-metadata.json`) says `token_endpoint_auth_method: private_key_jwt` and
  `jwks_uri: /techne/jwks.json` (the public half only). Without the key the door stays off, flag or not.
- "Sign in with Techne" is a plain form posting to `/techne/signin`. The server makes the pushed authorization request
  at the PDS (techne.town, or `TECHNE_PDS_URL`) and sends the browser to its sign-in page; "Make one" adds
  `prompt=create`. A nonce cookie ties the start to this browser.
- The PDS comes back to **`/techne/callback`, a server route**. The server exchanges the code itself; the library
  checks that the token's `sub` is a DID whose own PDS names this issuer; then this site checks it again
  (`lib/techne/oauth/issuer.ts`: did:plc only, DID document → `#atproto_pds` → protected-resource metadata →
  authorization server → `issuer` must equal the token's) and that the nonce cookie matches (login CSRF; it keeps the
  last three starts, so a sign-in begun in two tabs finishes in either; a mismatch revokes nothing, since the
  account's session may be in use in another browser). Only then:
  this browser's Techne sign-in (`lib/techne/webSession.ts`: an httpOnly cookie naming a server row, 30 days) and,
  **only for the member whose `members.did` is that DID**, the portal session (`lib/auth/mintSession.ts`). Nothing
  else mints a portal session from Techne; a token minted for any other app opens nothing here.
- Pending sign-ins and sessions (tokens, DPoP keys) live in Postgres (migration 064: `techne_oauth_states`,
  `techne_oauth_sessions`, `techne_web_sessions`), server only. One OAuth session per account, shared by that
  account's browsers; a new sign-in in a browser replaces that browser's old one. Expired web sessions, and OAuth
  sessions no browser has used for a day, are pruned at each sign-in. One web container, so the library's
  in-process lock is enough for refreshes; a second container would need a shared lock.
- If Techne can't be reached while a token is refreshed, the routes answer 503 and the sign-in stays; only a
  refused refresh or a revoked grant ends it. A linked member whose portal session can't open (no email on the
  membership, GoTrue down) is told so on `/auth/login` instead of being sent round again.
- A person whose account lives on another server is handed back by the Techne sign-in page
  (`error=login_required&login_hint=…`); the callback starts again there, at most twice (as techne-sdk did).

**RSVP and posting use the same server-held session** (the review asked: server routes, or keep the browser client).
Server routes: `GET/POST /api/techne/rsvp` and `POST /api/portal/events/write` restore the person's OAuth session and
call their PDS with it (DPoP), the same calls as before (`lib/techne/rsvpWrite.ts`, `collectiveWrite.ts`). Why not
keep the browser client too: it would be a second OAuth client with its own consent and its own session, so a person
would press "Sign in with Techne" twice and sign out twice; and a browser session can't prove to this server who it
is without the service-auth proof H1 removed. One client, one sign-in, one session.

**Linking an account that isn't linked yet.** `/auth/login` shows "Already a member? Enter the email on your
membership": `POST /api/auth/techne/link` (this browser's Techne sign-in + the email) → `begin_techne_link` finds the
member by that email and sends a single-use, 30-minute link to **the email on the member row**, after the response
(so the timing doesn't say whether the email is a member's). Same answer whether or not a member has the email;
nothing is sent for a membership already linked to another account. Limits: 30 asks an hour per IP (everyone at the
hub shares one IP; sign-in itself allows 300); 3 asks an hour per Techne account (429); 50 link emails an hour in all
("Linking is busy right now", checked before the email is looked up, so it says nothing about it); 10 link emails an
hour per member (silent). Link requests older than a day are deleted. Only did:plc accounts can link (a did:web costs nothing to make). The link page
(`/auth/techne/link?code=`) links nothing on open (mail scanners); the person presses "Link and open my portal",
which needs the **same Techne account that asked** (`confirm_techne_link` compares the DID). It writes `members.did`
and an `admin_actions` row `techne_did_linked` in one transaction, **emails the member that a Techne account was
linked** (with where to unlink it), then starts the portal session.

**Unlinking.** `/portal/profile` shows the linked Techne account with **Unlink**; admins have the same on the member
page (Access tab). `unlink_techne` (one transaction) clears `members.did`, ends that account's sign-ins here (web
sessions and the server-held OAuth session), ends the member's portal sessions (all of them for an admin; all but the
member's current one when they unlink themselves; access tokens already issued run out within the hour), and audits
`techne_did_unlinked` with who did it.

**Sign-out** is a plain form posting to `/auth/signout`: it deletes this browser's Techne cookie and its row first,
whatever the PDS does, revokes the OAuth session at the PDS (at most 3 s) and forgets it unless another browser is
still signed in with that account, then ends the Supabase session. Nothing is left in the browser that could sign back
in, and no page signs anyone in on its own: the portal session starts only in the callback and on link confirm.

**Requests.** Every state-changing JSON route of the door (link, confirm, RSVP, posting, unlink) needs
`content-type: application/json` and this site's `Origin`, so another site can't post a form at it (login CSRF).

**Accepted risks (review, 11-17; updated after the fix).** (1) Whoever runs pds.techne.town can sign in as any
account it hosts, so can open every linked member's portal; true of any "Sign in with Techne". (2) A disabled member
can still sign in, as with the email link (parity, not new). (3) A Techne sign-in for RSVP also opens the portal for a
linked member (by design: one door); on a shared computer, press Sign out. (4) Billing and admin pages check the
session they are given; they are not a second factor. The portal session from Techne is the same one an email link
gives, and now only a sign-in through this site's own client starts it. (5) Per-IP limits fail open if the database
can't answer (logged), so a database hiccup doesn't lock people out. (6) A callback refused here (not started in this
browser) has already replaced the account's stored grant: that is the OAuth library's order, and the grant came from
the account's own PDS after its own approval; no sign-in starts from it. (7) Someone with ~17 throwaway Techne accounts
can hold link emails at the 50-an-hour cap; members then read "Linking is busy" and can use an email link. (8) A
member who came in by email link and whose membership has no Techne account linked keeps that portal session when the
browser signs in with any Techne account (the steward who posts with Techne after an email link). A portal session for
a member linked to a different Techne account ends at that sign-in (this browser only).

**Not a member.** A visitor signs in, RSVPs, and `/auth/login` tells them they can RSVP and points to /membership and
/apply. They get no portal session. `/apply` asks them for an email link (an application needs a reachable email).

**Every sign-in is a person with an email (T-497, 2026-11-20).** Aaron, 11-20: "If people sign up to a Techne
account, shouldn't we get their email right away and create them an account on our site?" The one scope list now
includes `transition:email` (`lib/techne/session.ts`). pds.techne.town lists it in `scopes_supported` (read-only,
11-20: `["atproto", "transition:email", "transition:generic", "transition:chat.bsky"]`); the granular `account:email`
is not listed there, so we don't ask for it. The Techne docs (quickstart, reference, building-an-app) and the Techne
MCP guide say nothing about email either way. At `/techne/callback` the server reads `com.atproto.server.getSession` on
the person's own PDS (email + `emailConfirmed`) and the public display name, then `record_techne_sign_in` (migration
067, `lib/techne/person.ts`) saves the person in `techne_people`, links the member (by `members.did`, else a confirmed
email matching one member who has no Techne account), and puts a confirmed email on the stay-in-touch list
(`interests`, `source_path 'techne'`) unless it is there already, a member's, unsubscribed, or declined. That sign-in
leaves a one-time line, "We'll send you RegenHub news. No thanks". None of it opens the portal or writes
`members.did` (that still takes the emailed link), and none of it can fail a sign-in: a PDS that doesn't answer, or a
grant without the email scope, just records no email.
- **Whose "confirmed" counts:** only the home PDS's (pds.techne.town, or `TECHNE_PDS_URL`), the server whose sign-up
  proves the email with a code. An account on another server (reached by hand-back) keeps its email as unconfirmed: it
  links no member, joins no list and gets no note, because anyone can run a PDS that says an address is confirmed.
- **The list decision is per email:** a new email on the PDS is looked at again at the next sign-in, and the entry this
  added for the old address goes (the entry follows the person); "No thanks" stays (it was about us, not the address).
  A disabled member's email counts as already handled: the newsletter leaves disabled members out on purpose. An email-matched member counts only while the
  member's email is still the one the account confirmed.
- **Counts:** these list rows (`source_path 'techne'`) count in the admin "Interest signups", the daily digest and the
  scoreboard's stay-in-touch funnel like any signup.
- **Before this shipped:** an account that signed in earlier has a grant without the email scope. Nothing breaks
  (RSVP and posting keep working on the old grant); its email is read at its next sign-in. No backfill, no forced
  re-consent: a new sign-in shows the PDS's consent with the email line, and the email link stays the fallback.
- **Night follow-ups** reach a Techne-only RSVP through `techne_people` (confirmed email only), with every hold rule.
- **Unproven until one real sign-in:** that pds.techne.town's consent page grants `transition:email` to a community
  app and its `getSession` answers the email under it (a stock atproto PDS does). If it grants a session without it,
  the sign-in still works and records no email: ask Lucian.

**Unproven until one real sign-in** (needs a deploy with the flag on and the key set): that pds.techne.town fetches
`/techne/client-metadata.json` and `/techne/jwks.json` and accepts our client assertion at PAR and at the token
endpoint. Read-only on 11-17: its metadata validates with the library and lists `private_key_jwt` with ES256, required
PAR, DPoP ES256, client-id metadata documents, the `iss` parameter and `prompt=create`. If it refuses, `/auth/login`
says "Sign-in with Techne didn't finish" and the email link still opens the portal.

**Every sign-in surface now** (door on):

| Surface | Shows |
|---|---|
| `/auth/login` (and `/portal`, `/portal/*`, `/admin` redirects to it) | "Sign in with Techne" + "Make one"; "Use an email link instead" folded. Signed in to both: straight to `next`. Signed in with Techne, not linked: "Already a member?" email link form, "Not a member yet?" links, "A facilitator or manager of RegenHub on Techne? Manage events", Sign out |
| `/apply` signed out | Same door; a non-member is asked for an email link to apply with |
| `/login` | Redirects to `/auth/login` |
| Event page RSVP panel | "Sign in with Techne" (back to the event); the sign-in also opens the portal for a linked member. "Sign out" ends both, back to the event |
| `/admin/events` (`/portal/events` redirects here) | Not signed in with Techne: "Sign in with Techne". Signed in at facilitator or above in RegenHub on Techne: the calendar and form, with or without a site membership. Anyone else: an explainer naming the managers, no form |
| `/portal/profile`, admin member page | The linked Techne account with Unlink |
| `/auth/techne/link?code=` | "Sign in with the Techne account you asked from", then "Link and open my portal" |
| Portal header | "Sign out" ends both sessions |

Door off: `/auth/login` and `/apply` are the email link form, as before; the routes 404.

**No scenius anywhere:** the regenOS panel is gone from `/auth/login` and `/apply`, the "Link regenOS" card from
`/portal`, the "Old steward page" link from `/portal/events`. The lane's code stays behind `REGENOS_LOGIN_ENABLED`
(off in production) until it is deleted (below). Two landing strings use "scenius" as a concept, unchanged from main
(`ForestMascot.tsx`, `RegenHubLanding.tsx`): copy, not sign-in; left for Aaron.

**Subtract.** This replaces the browser client (techne-sdk/auth `signIn`/`restore`, `useTechneSession`), the
service-auth door (`/api/auth/techne/session`, `serviceAuth.ts`, `portalAuth.ts`, the `rpc:xyz.regenhub.portal.signIn`
scope, `use_techne_proof`) and the `/auth/login?signed_out=1` clean-up: all deleted in this PR, before any of it
shipped.

## Study, with sources

### Writing as the collective (Aaron 11-17: "just standard atproto stuff with the Techne layer on top")

- Who: "the caller then writes as the collective (permissioned.putRecords or com.atproto.repo.applyWrites, repo =
  the new DID) … only whoever manages its own member space (`pub.techne.draft.space.collective.member/self`) may"
  (techne-sdk 0.4.0 lexicons, `pub.techne.draft.identity.createCollective`). A collective's manage leg is
  "Facilitator and up" (`pub.techne.draft.appAccess`): role ≥ 30.
- Where the call goes: **the steward's own PDS, answering it itself.** techne.computer/ref-applywrites.html: "Your
  PDS answers it, not techne.computer". RegenHub (did:plc:dl3lexgjfg2euvkqvao4wsgs, `regenhub.techne.town`) and
  its stewards (e.g. `unforced.techne.town`) both live on `https://pds.techne.town` (plc.directory). The earlier
  version sent it through the PDS with `atproto-proxy: did:web:techne.computer#atproto_appview`; pds.techne.town
  refuses that for every `com.atproto.repo.*` method: 403 "… is not forwarded to did:web:techne.computer#atproto_appview"
  (review of PR #121, B1, GET probes without auth). Only platform methods are forwarded (`sync.indexRecord` "is
  forwarded as POST only"), so the `sync.indexRecord` hints keep the proxy header.
- **Unproven until one real post:** whether pds.techne.town lets a manager of RegenHub's member space write
  RegenHub's repo with their own OAuth session. That is the Techne layer. Nothing read-only can show it; the first
  real post after deploy does. If it refuses, the steward reads "Techne didn't accept a post as RegenHub from this
  account. … (Techne said: <the PDS's own text>)", and the browser console logs the status and error code
  (`[techne] com.atproto.repo.applyWrites as <did>: <status> <error>`).
- What: public records, so `applyWrites`, not `permissioned.putRecords` (which needs a `space`). Shape as the
  platform's own events and techne-sdk/put `eventRecords`: `community.lexicon.calendar.event` at a TID key,
  `pub.techne.draft.event.config` at `{rkey}-cfg` (attendance, `timezone: America/Denver`), and the collective's
  `pub.techne.draft.event.listing` at `{rkey}-ctx` ("the platform keys the listing that puts a collective's own event
  on its calendar `{rkey}-ctx`", listing lexicon). Config and listing point at the event by URI and CID, from
  techne-sdk/put `plan` (we call `plan` rather than `eventRecords` because `eventRecords` picks the event's key
  itself, and an edit must keep the existing key). After the write, one `sync.indexRecord` hint per record
  (building-an-app.md *Write*).
- Edit: `#update` of the event (keeps `createdAt` and fields the form doesn't own, such as `uris`), the config
  (keeps waitlist, capacity, attendance) and the listing, or `#create` for a sibling that doesn't exist yet.
  Remove: `#delete` of the event and whichever siblings exist. "Remove" deletes; people who RSVP'd aren't told.
- Public only: a private event lives in its invite space, which needs `authPermissioned` writes and a `space:`
  scope beyond the app's own (the red consent warning). The form doesn't offer "private".
- Answers (`lib/techne/collectiveWrite.ts`), error name first: `ExpiredToken`, `InvalidToken`, `invalid_token` or
  `invalid_dpop_proof` (in the body, or `WWW-Authenticate`'s `error=`) below 500 = sign in again; a second
  `use_dpop_nonce` = nothing written, try again; then any
  other 401/403 = Techne didn't accept the post from this account, in its own words, "if you think it should have,
  sign out and in again" (a reference PDS answers "not your repo" with 401 `AuthenticationRequired`);
  400/404/409/413/415/422 = nothing written, try again; anything else (5xx, no answer) = reload before retrying.
- Live check (2026-11-17): RegenHub's existing event `ev-mtishcrx6pltz6` has exactly this shape (event, `-cfg`
  with `attendance`/`waitlist`, `-ctx` listing), read from pds.techne.town.

### Scopes: one sign-in for everyone (Aaron, 11-17)

- One list, members and stewards alike (`lib/techne/session.ts` `signInScope`): `atproto`, `repo:` for
  `community.lexicon.calendar.rsvp`, `community.lexicon.calendar.event`, `pub.techne.draft.event.config` and
  `pub.techne.draft.event.listing`, plus techne-sdk's defaults (`authPermissioned`, the app's own private space,
  `rpc:` for the generic reads and `sync.indexRecord`); techne-sdk/auth `scopes({ types })`.
- `repo:<nsid>`: "create, edit and delete those public records" (building-an-app.md *Permissions*); in atproto
  these cover `applyWrites` too, so the write as the collective needs no `rpc:` scope. Which repo the PDS lets
  you write is not a scope question: Techne decides on the write.
- **No red warning.** "a red warning when the app can read or write other private data (authRead, authWrite, any
  other `space:` scope, or a call we can't bound). The SDK's defaults, with `types` and `publish`, stay off the red
  one" (building-an-app.md *Permissions*). Asking for the event types keeps the community banner "public records
  plus the app's own space".
- A wider "steward level" that could read RegenHub's member roles was dropped (Aaron: "Isn't everybody just doing
  a sign in with Techne?"). The docs give no narrow scope for one collective's member space: the only reads of
  private spaces are `include:pub.techne.draft.authRead` or "any other `space:` scope", both the red warning.
- The client metadata declares exactly this list, so a hand-back to another server (techne-sdk restarts sign-in
  with the metadata's scope) asks for no more than a first sign-in.

### Who stewards RegenHub

- `pub.techne.draft.membership` is "a statement by a collective that someone holds a role in it … Authored ONLY
  by the collective … (today 10=member, 20=builder, 30=facilitator, 40=steward) … End a membership with
  validUntil" (`registry.getType?nsid=pub.techne.draft.membership`). Its query document maps `subject` to the
  `references` role as `at://{did}`.
- Read: `query.listRecords` `{type is pub.techne.draft.membership, author is <collective>, references is
  at://<did>}` — public, no sign-in (reference.html *Query*; building-an-app.md *Read*). The DID comes from the
  person's Techne session. `lib/techne/roster.ts` (`claimsFrom`, `holdersFrom`) counts only claims in the
  collective's own repo, inside `validFrom`/`validUntil`, and takes each person's highest role.
- Live, 2026-11-17: RegenHub has one public membership, `unforced.techne.town`, role 40.
- Limit: a claim the collective placed in its member space is invisible to this read and to the default scopes
  ("The platform narrows the queries to public data and the app's own space", building-an-app.md *Permissions*).
- Since 11-19 this read is the gate, not a hint: `stewardCheck` (the whole roster, read fresh) decides who gets
  `/admin/events` and `/admin/stewards` and who their write routes accept (facilitator, 30, or above). Techne
  still checks every write itself. The old hint route (`GET /api/portal/events/standing`, `lib/techne/standing.ts`)
  is gone.

### Managing RegenHub's roles: /admin/stewards (T-482, Aaron 11-19)

- With the admin pages, but its authority is the Techne role: a Techne sign-in at facilitator (30) or above in
  RegenHub's public membership claims. `members.is_admin` neither grants it nor is needed (the admin pages moved
  into `app/admin/(staff)/`, whose layout keeps the `is_admin` gate; the admin frame only picks which links show).
- Lists every live claim (handle verified both ways, else short DID), highest role first. Add (a handle, resolved
  the atproto way and checked against the DID document), change and end. One `writeAsCollective` per action
  (`POST /api/techne/stewards`, `lib/techne/roster.ts`, sent by `sendCollectiveBatch`): the roster is read fresh
  on the server, never taken from the page.
- Names follow Techne today: member 20, facilitator 30, manager 40 (`lib/techne/roles.ts`; the lexicon's older
  index says 10=member, 40=steward). Keys follow the founder claim: `mb-self-<did>`, rewritten in place on a role
  change; ending sets `validUntil` (never a delete); adding back someone whose claim ended writes
  `mb-self-<did>-<tid>` so the ended one keeps its end. No `addedBy` (the lexicon: no public collective stamps it).
- Refused: any change that leaves nobody at >= 30 (Techne's LastManager rule). Raises are written before lowers.
- Unproven until one real change: that Techne's writeAsCollective takes a `pub.techne.draft.membership` write from
  a manager (events through the same call are proven live, 11-19).

### Client metadata

- "The app is its client metadata URL (`client_id`) … no registration" (building-an-app.md *Sign-in*).
  regenhub.xyz serves its metadata at `https://regenhub.xyz/techne/client-metadata.json` (confidential since the
  PR #122 review: `private_key_jwt`, `jwks_uri` `/techne/jwks.json`), redirect `https://regenhub.xyz/techne/callback`
  (a server route), name RegenHub, logo `/regenhub-logo.svg`. (`/oauth-client-metadata.json` is the old regenOS
  lane's client; it is a different client.)
- The docs' quickstart is a browser client ("The browser keeps one stored session per origin"). This site is a
  server client instead (One door, above), so the one session is the server's, per person, and RSVP and the steward
  page share it.

### techne-sdk 0.4.0 vs the docs

The quickstart documents `techne-sdk/auth/react` (`useSession`, `useAuthStatus`, `useSignOut`,
`<SignInWithTechne />`) and `techne-sdk/types`; 0.4.0 ships neither (`techne-sdk/react` has `TechneProvider`,
`useTechne`, `useEvent`). The quickstart says so itself ("not in techne-sdk 0.3.4 yet"). Since the server became
the client, the site uses techne-sdk only for `scopes()` (the one scope list), `put`'s `plan`, and its constants; the
button is a plain form (`components/techne/SignInWithTechne.tsx`).

## Questions still open for Lucian

1. Does pds.techne.town let someone who manages a collective's member space write that collective's repo (it hosts
   both) with a plain `com.atproto.repo.applyWrites`, repo = the collective, under their own OAuth session and
   `repo:` scopes? That is the path the code takes; one real post answers it. If the answer is "use another
   method", only `lib/techne/collectiveWrite.ts` changes.
2. Does the platform write the `{rkey}-ctx` listing itself when a collective's event arrives this way? We write it
   in the same batch; if the platform also does, ours is an update of the same record.
3. A role the collective keeps in its member space (not public) is invisible to the page's hint without
   `authRead`. Is there a narrow, documented read for "this person manages collective X"? (Today the page shows the
   form to everyone and the write decides.)

## Production config

Each line was checked with one real read-only call on 2026-11-17.

| Change | Why | Checked |
|---|---|---|
| `REGENOS_BASE_URL=https://techne.computer` (from `https://scenius.social`) | The docs' API host; the documented reads answer there | `query.listRecords` (RegenHub's events, its listings, its memberships by `references`), `query.getRecords` (one event), the RSVP-by-subject query: all 200 with data. `/.well-known/did.json` names `https://techne.computer` as `#atproto_appview` |
| `REGENOS_COLLECTIVE_DID` unchanged (`did:plc:dl3lexgjfg2euvkqvao4wsgs`) | | plc.directory: handle `regenhub.techne.town`, PDS `https://pds.techne.town`; descriptor `pub.techne.draft.collective/self` = "RegenHub" |
| `TECHNE_OAUTH_PRIVATE_JWK` = the output of `node scripts/techne-oauth-key.mjs` (secret; Coolify only) | The OAuth client's signing key (`private_key_jwt`). Without it the door stays off | pds.techne.town lists `private_key_jwt` with ES256 (read-only, 11-17); the first real sign-in proves it accepts ours |
| `TECHNE_SIGNIN_ENABLED=true` (new name; drop `TECHNE_RSVP_ENABLED` if set) | Turns on the door, `/techne/client-metadata.json`, `/techne/callback`, the Techne `/admin/events` (`/portal/events` redirects there; the old page moves to `/portal/events/old`) | `https://pds.techne.town/.well-known/oauth-authorization-server`: issuer pds.techne.town, `client_id_metadata_document_supported: true`, DPoP ES256; handle resolution `unforced.techne.town` → did:plc:3hmy2v5fvvdh7vuujef5upvl. `https://regenhub.xyz/techne/client-metadata.json` answers 200 today with main's public (`none`) browser client: the flag is already on in production; `/techne/jwks.json` and `/techne/signin` are 404 until this PR ships |
| `REGENOS_LOGIN_ENABLED=false` (Uni set it off 11-17 as a stopgap; keep it off) | That lane is what emailed a scenius link that went to beacon.techne.computer | With the one door no page shows the lane either way. With it off, `/login` redirects there, `/oauth/callback` is a 404, **the "Old steward page" goes away**, and **`/admin/members` "Sync claims to regenOS" turns off too** (it rides the same lane) |
| Apply migration `064_techne_one_door.sql` **before** deploying (MCP `run_migration`; it is additive and main's code never touches its tables) | The one door's tables and functions; deployed without them, sign-in can't start (`/auth/login?error=techne_start`) | Confirmed in a test: with the OAuth-state table missing, sign-in answers 303 to `/auth/login?error=techne_start` |
| Apply `067_techne_people.sql` after deploying (MCP `run_migration`; additive) | Every sign-in saved as a person with an email (T-497) | Until it runs, sign-ins log "recording the person failed" and carry on; follow-ups read members only |
| No `TECHNE_PDS_URL`, `TECHNE_PLC_URL`, `TECHNE_HANDLE_DOMAIN`, `TECHNE_PLATFORM_DID`, `TECHNE_STAGING_STANDIN` | Production uses the SDK's defaults; the stand-in is refused for regenhub.xyz anyway | |

The env vars are runtime: set them in Coolify and redeploy the web app. Production deploy is Aaron's go.

### Deploy order (the flag is already on in production)

Production runs main with `TECHNE_SIGNIN_ENABLED` on, so **deploying this PR is the moment the one door opens**, and
the order matters:

1. Generate the key (`node scripts/techne-oauth-key.mjs`) and set `TECHNE_OAUTH_PRIVATE_JWK` in Coolify. **Deploying
   without it switches the door off**: live Techne RSVP and the Techne Manage Events page disappear until it is set.
2. Apply `064_techne_one_door.sql` (`run_migration`). Additive; main's code ignores the new tables. Try one Unlink on a
   test member right after (its `auth.sessions` delete has never run outside a test database).
3. Deploy the web app. The client id stays the same but turns from public to confidential, so the PDS's cached metadata
   may lag a few minutes.
4. One real sign-in (and a sign-out then sign-in again, to see whether the PDS asks who you are).

Before step 3, read `select id, did from members where did is not null`: rows written by the old regenOS lane open
their portal on day one without the email-link proof.

## Old steward page, and the old lane: remove later (not done here)

The old Manage Events (`components/portal/legacy/`, `/portal/events/old`, Import from Luma) is kept unchanged so
production with the Techne door off is as before, and so stewards have a working page until one real post works
through the new one. The old lane also backs `/auth/login`'s regenOS panel, `/login`, `/oauth/*`,
`/oauth-client-metadata.json`, `/api/auth/regenos/*`, the `/xrpc` proxy, `/api/portal/events/import-luma`,
`fetchCollectiveEventsForManagement`, `lib/regenos/auth.ts` and `/admin/members` membership sync.
**Subtract (one door, 11-17):** no page offers the old lane any more. Proposed: delete the whole lane in one PR
(`components/auth/RegenosLoginPanel.tsx`, `MagicLinkWizard.tsx`, `OAuthSignInButton.tsx`, `OAuthCallback.tsx`,
`components/portal/LinkRegenOSCard.tsx`, `app/login`, `app/oauth`, `app/oauth-client-metadata.json`,
`app/api/auth/regenos/*`, the `/xrpc` proxy, `lib/regenos/{auth,oauth,signupWizard,syntheticEmail,writeDid}.ts`, the
regenOS branch of `/auth/signout`) together with the old steward page below. Earlier plan:
once one real post works through the Techne door and Aaron retires the old page, delete
`components/portal/legacy/`, `app/portal/events/old/`, the `OldStewardPage` branch in `app/portal/events/page.tsx`
and the `isRegenosLoginEnabled` half of `isStewardEventsEnabled`; then the rest of the lane in one PR (with
`REGENOS_LOGIN_ENABLED`, `REGENOS_OAUTH_JWKS_URI`) once Aaron has decided on membership sync. Proposed date for the old page to go:
2026-12-15 (Aaron's call; sooner if the first real post works, later if it doesn't).
