# Sign in with Techne on regenhub.xyz (T-482, part 2)

One door for Techne: a member RSVPs and a steward manages RegenHub's calendar with the same "Sign in with
Techne" session. Supabase email login stays the door for billing and the portal. Written 2026-11-17 from the
public docs only (techne.computer/llms.txt and what it lists, reference.html, techne.pub, the lexicons in npm
`techne-sdk@0.4.0`) and read-only calls to the live platform.

## What changed

- With `TECHNE_SIGNIN_ENABLED` **off** (production today) Manage Events is exactly as before T-482: the old
  regenOS-lane page at `/portal/events` (`components/portal/legacy/`, main's code unchanged, Import from Luma
  included), its nav link and dashboard card, and the revalidate route, all on `REGENOS_LOGIN_ENABLED`
  (`isStewardEventsEnabled`, `lib/techne/config.ts`).
- With it **on**, `/portal/events` is the Techne door: the same client id, scopes and session as RSVP
  (`components/techne/useTechneSession.ts`). The old page stays reachable at `/portal/events/old`, linked as
  "Old steward page" from the new one while the regenOS lane is on, until Aaron retires it.
- The calendar on that page is the documented public read every visitor gets, plus each event's config and
  listing (`query.getRecords`), so edits keep them and removal deletes exactly what exists.
- **Everyone signed in with Techne gets the posting form.** RegenHub's public membership claims only word a hint
  (the person's role, or "Posting works if you manage RegenHub on Techne"). Techne decides on the write.
- Posting, editing and removing write **as the collective**: the event, its config and its listing in RegenHub's
  repo, in one standard `com.atproto.repo.applyWrites` sent **straight to the steward's own PDS, with no
  `atproto-proxy` header** (`lib/techne/collectiveEvents.ts`, `lib/techne/collectiveWrite.ts`).
- `TECHNE_RSVP_ENABLED` is renamed `TECHNE_SIGNIN_ENABLED` (it now covers both pages). It was off in production.

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
  account. Techne said: <the PDS's own text>", and the browser console logs the status and error code
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
- Answers: 401/403 (other than a lapsed token: `ExpiredToken`/`InvalidToken`) = Techne didn't accept the post from
  this account, in its own words (a reference PDS answers "not your repo" with 401 `AuthenticationRequired`);
  a lapsed token = sign in again; 400/404/409/413/415/422 = nothing written, try again; anything else (5xx, no
  answer) = reload before retrying.
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
  person's Techne session. `lib/techne/standing.ts` counts only claims in the collective's own repo about exactly
  that DID, inside `validFrom`/`validUntil`, and takes the highest role.
- Live, 2026-11-17: RegenHub has one public membership, `unforced.techne.town`, role 40.
- Limit: a claim the collective placed in its member space is invisible to this read and to the default scopes
  ("The platform narrows the queries to public data and the app's own space", building-an-app.md *Permissions*).
- This read only words the hint on the page (everyone signed in gets the form). Techne checks every write itself.
  `GET /api/portal/events/standing` needs the portal session and reads through a one-minute cache.

### Client metadata

- "The app is its client metadata URL (`client_id`) … no registration" (building-an-app.md *Sign-in*).
  regenhub.xyz serves `clientMetadata()` at `https://regenhub.xyz/techne/client-metadata.json`, redirect
  `https://regenhub.xyz/techne/callback`, name RegenHub, logo `/regenhub-logo.svg`. (`/oauth-client-metadata.json`
  is the old regenOS lane's client; it is a different client.)
- "The browser keeps one stored session per origin" (building-an-app.md *Sign-in*): one client id for the whole
  site is what makes RSVP and the steward page one session.

### techne-sdk 0.4.0 vs the docs

The quickstart documents `techne-sdk/auth/react` (`useSession`, `useAuthStatus`, `useSignOut`,
`<SignInWithTechne />`) and `techne-sdk/types`; 0.4.0 ships neither (`techne-sdk/react` has `TechneProvider`,
`useTechne`, `useEvent`). The quickstart says so itself ("not in techne-sdk 0.3.4 yet"). We keep a hand-built
button on `signIn`/`signUp`/`restore`/`signOut`.

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
| `TECHNE_SIGNIN_ENABLED=true` (new name; drop `TECHNE_RSVP_ENABLED` if set) | Turns on the door, `/techne/client-metadata.json`, `/techne/callback`, the Techne `/portal/events` (old page moves to `/portal/events/old`) | `https://pds.techne.town/.well-known/oauth-authorization-server`: issuer pds.techne.town, `client_id_metadata_document_supported: true`, DPoP ES256; handle resolution `unforced.techne.town` → did:plc:3hmy2v5fvvdh7vuujef5upvl. `https://regenhub.xyz/techne/client-metadata.json` is 404 today (flag off), as expected |
| `REGENOS_LOGIN_ENABLED=false` (Aaron's call, only after one real post works through the Techne door) | That lane is what emailed a scenius link that went to beacon.techne.computer | Not flipped by us. With it off, `/auth/login` shows only the Supabase door, `/login` redirects there, `/oauth/callback` is a 404, **the "Old steward page" goes away**, and **`/admin/members` "Sync claims to regenOS" turns off too** (it rides the same lane) |
| No `TECHNE_PDS_URL`, `TECHNE_PLC_URL`, `TECHNE_HANDLE_DOMAIN`, `TECHNE_PLATFORM_DID`, `TECHNE_STAGING_STANDIN` | Production uses the SDK's defaults; the stand-in is refused for regenhub.xyz anyway | |

The env vars are runtime: set them in Coolify and redeploy the web app. Production deploy is Aaron's go.

## Old steward page, and the old lane: remove later (not done here)

The old Manage Events (`components/portal/legacy/`, `/portal/events/old`, Import from Luma) is kept unchanged so
production with the Techne door off is as before, and so stewards have a working page until one real post works
through the new one. The old lane also backs `/auth/login`'s regenOS panel, `/login`, `/oauth/*`,
`/oauth-client-metadata.json`, `/api/auth/regenos/*`, the `/xrpc` proxy, `/api/portal/events/import-luma`,
`fetchCollectiveEventsForManagement`, `lib/regenos/auth.ts` and `/admin/members` membership sync.
**Subtract:** once one real post works through the Techne door and Aaron retires the old page, delete
`components/portal/legacy/`, `app/portal/events/old/`, the `OldStewardPage` branch in `app/portal/events/page.tsx`
and the `isRegenosLoginEnabled` half of `isStewardEventsEnabled`; then the rest of the lane in one PR (with
`REGENOS_LOGIN_ENABLED`, `REGENOS_OAUTH_JWKS_URI`) once Aaron has decided on membership sync. No date set: it
waits on the first real post.
