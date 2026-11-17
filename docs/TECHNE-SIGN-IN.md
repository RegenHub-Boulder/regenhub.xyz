# Sign in with Techne on regenhub.xyz (T-482, part 2)

One door for Techne: a member RSVPs and a steward manages RegenHub's calendar with the same "Sign in with
Techne" session. Supabase email login stays the door for billing and the portal. Written 2026-11-17 from the
public docs only (techne.computer/llms.txt and what it lists, reference.html, techne.pub, the lexicons in npm
`techne-sdk@0.4.0`) and read-only calls to the live platform.

## What changed

- `/portal/events` no longer uses the old regenOS lane (scenius cookie, magic link, `/xrpc` proxy). A steward
  signs in with Techne: the same client id and session as RSVP (`components/techne/useTechneSession.ts`), at the
  steward level of the sign-in (below).
- The calendar on that page is the documented public read every visitor gets, plus each event's config and
  listing (`query.getRecords`), so edits keep them and removal deletes exactly what exists.
- Who may post comes from the collective's public membership claims: role ≥ 30 (below).
- Posting, editing and removing write **as the collective**: the event, its config and its listing in RegenHub's
  repo, in one `com.atproto.repo.applyWrites` at the platform, through the steward's own PDS
  (`lib/techne/collectiveEvents.ts`, `lib/techne/collectiveWrite.ts`).
- `TECHNE_RSVP_ENABLED` is renamed `TECHNE_SIGNIN_ENABLED` (it now covers both pages). It was off in production.

## Study, with sources

### Writing as the collective (settled by the addendum, 11-17)

- Who: "the caller then writes as the collective (permissioned.putRecords or com.atproto.repo.applyWrites, repo =
  the new DID) … only whoever manages its own member space (`pub.techne.draft.space.collective.member/self`) may"
  (techne-sdk 0.4.0 lexicons, `pub.techne.draft.identity.createCollective`). The platform holds the collective's
  credential. A collective's manage leg is "Facilitator and up" (`pub.techne.draft.appAccess`), so the page offers
  posting at role ≥ 30.
- Where the call goes: not to the steward's own PDS (a PDS session writes only that person's repo; techne-sdk's
  `put` and `connect` write to `techne.did`). It goes to the **platform's** `com.atproto.repo.applyWrites`, which
  "it relays to the repo's PDS with the credential it holds" (techne-sdk/connect, `connectHosted`), reached the
  documented way for platform calls: through the person's PDS with `atproto-proxy: did:web:techne.computer#atproto_appview`
  (techne-sdk/connect module doc; quickstart *Log in*: "reads reach techne.computer through their PDS").
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
  scope beyond the app's own (the red consent warning). The form no longer offers "private".
- How the app knows it may: the public membership read below decides what the page offers; the platform's answer
  is the last word. A 401/403 shows above the calendar: "Techne didn't let you post as RegenHub. Only people who
  manage RegenHub's membership on Techne can." Anything else: "Couldn't reach Techne, nothing changed."
- Live check (2026-11-17): RegenHub's existing event `ev-mtishcrx6pltz6` has exactly this shape (event, `-cfg`
  with `attendance`/`waitlist`, `-ctx` listing), read from pds.techne.town.
- **Not provable read-only:** that the steward's PDS (techne.town's ePDS) forwards `com.atproto.repo.applyWrites`
  with `atproto-proxy` to the platform under an `rpc:com.atproto.repo.applyWrites?aud=…` scope. A reference
  atproto PDS handles `com.atproto.repo.*` itself; whether techne.town's proxies it is the one question left
  (below). An anonymous POST to `techne.computer/xrpc/com.atproto.repo.applyWrites` got an edge 403 HTML page, which
  says nothing either way.

### Scopes: two levels, one client

- Member (RSVP): `atproto`, `repo:community.lexicon.calendar.rsvp`, and techne-sdk's defaults (`authPermissioned`,
  the app's own private space, `rpc:` for the generic reads and `sync.indexRecord`), building-an-app.md
  *Permissions*; techne-sdk/auth `scopes()`. The community banner for "public records plus the app's own space".
- Steward: the member list plus `repo:` for `community.lexicon.calendar.event`, `pub.techne.draft.event.config`,
  `pub.techne.draft.event.listing`, and `rpc:com.atproto.repo.applyWrites?aud=did:web:techne.computer%23atproto_appview`
  (`lib/techne/session.ts` `signInScope`).
- The client metadata declares the steward list, the most any sign-in asks for; `signIn` may ask for less
  (techne-sdk/auth: "the PDS refuses a request beyond what the metadata declares"; the SDK loads the hosted
  metadata with `BrowserOAuthClient.load`). So a member only consents to RSVP. A steward who first signed in to
  RSVP sees "One more yes to post as RegenHub" and signs in again at the steward level (the granted scope is read
  with the session's `getTokenInfo`).

### Who stewards RegenHub

- `pub.techne.draft.membership` is "a statement by a collective that someone holds a role in it … Authored ONLY
  by the collective … (today 10=member, 20=builder, 30=facilitator, 40=steward) … End a membership with
  validUntil" (`registry.getType?nsid=pub.techne.draft.membership`). Its query document maps `subject` to the
  `references` role as `at://{did}`.
- Read: `query.listRecords` `{type is pub.techne.draft.membership, author is <collective>, references is
  at://<did>}` — public, no sign-in (reference.html *Query*; building-an-app.md *Read*). The DID comes from the
  person's Techne session. `lib/techne/standing.ts` counts only claims in the collective's own repo about exactly
  that DID, inside `validFrom`/`validUntil`, and takes the highest role. Facilitator (30) and up may post: the
  member space's manage leg, which holds the collective's pen (above).
- Live, 2026-11-17: RegenHub has one public membership, `unforced.techne.town`, role 40.
- Limit: a claim the collective placed in its member space is invisible to this read and to the default scopes
  ("The platform narrows the queries to public data and the app's own space", building-an-app.md *Permissions*).
- This check only decides what the page offers. The platform checks every write itself.

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

1. Does techne.town's PDS forward `com.atproto.repo.applyWrites` (with `atproto-proxy:
   did:web:techne.computer#atproto_appview`) to the platform under `rpc:com.atproto.repo.applyWrites?aud=…`, and does
   the platform then write a public record into the collective's repo for a member-space manager? That is the path
   the code takes; if the answer is "use another method", only `lib/techne/collectiveWrite.ts` and one scope change.
2. Does the platform write the `{rkey}-ctx` listing itself when a collective's event arrives this way? We write it
   in the same batch; if the platform also does, ours is an update of the same record.
3. A role the collective keeps in its member space (not public) is invisible to the page's check without
   `authRead`. Is there a documented read for "this person manages collective X"? (Today the platform's answer on
   the write is the fallback.)

## Production config

Each line was checked with one real read-only call on 2026-11-17.

| Change | Why | Checked |
|---|---|---|
| `REGENOS_BASE_URL=https://techne.computer` (from `https://scenius.social`) | The docs' API host; the documented reads answer there | `query.listRecords` (RegenHub's events, its listings, its memberships by `references`), `query.getRecords` (one event), the RSVP-by-subject query: all 200 with data. `/.well-known/did.json` names `https://techne.computer` as `#atproto_appview` |
| `REGENOS_COLLECTIVE_DID` unchanged (`did:plc:dl3lexgjfg2euvkqvao4wsgs`) | | plc.directory: handle `regenhub.techne.town`, PDS `https://pds.techne.town`; descriptor `pub.techne.draft.collective/self` = "RegenHub" |
| `TECHNE_SIGNIN_ENABLED=true` (new name; drop `TECHNE_RSVP_ENABLED` if set) | Turns on the door, `/techne/client-metadata.json`, `/techne/callback`, `/portal/events` | `https://pds.techne.town/.well-known/oauth-authorization-server`: issuer pds.techne.town, `client_id_metadata_document_supported: true`, DPoP ES256; handle resolution `unforced.techne.town` → did:plc:3hmy2v5fvvdh7vuujef5upvl. `https://regenhub.xyz/techne/client-metadata.json` is 404 today (flag off), as expected |
| `REGENOS_LOGIN_ENABLED=false` (recommended, Aaron's call) | That lane is what emailed a scenius link that went to beacon.techne.computer | Not flipped by us. With it off, `/auth/login` shows only the Supabase door, `/login` redirects there, `/oauth/callback` is a 404, and **`/admin/members` "Sync claims to regenOS" turns off too** (it rides the same lane) |
| No `TECHNE_PDS_URL`, `TECHNE_PLC_URL`, `TECHNE_HANDLE_DOMAIN`, `TECHNE_PLATFORM_DID`, `TECHNE_STAGING_STANDIN` | Production uses the SDK's defaults; the stand-in is refused for regenhub.xyz anyway | |

The env vars are runtime: set them in Coolify and redeploy the web app. Production deploy is Aaron's go.

## Old lane: propose removing (not done here)

Nothing on `/events`, the event pages or `/portal/events` uses it now. It still backs `/auth/login`'s regenOS
panel, `/login`, `/oauth/*`, `/oauth-client-metadata.json`, `/api/auth/regenos/*`, the `/xrpc` proxy, Luma
import (`/api/portal/events/import-luma`), the legacy steward read (`fetchCollectiveEventsForManagement`,
`lib/regenos/auth.ts`) and `/admin/members` membership sync. Proposal: once one real post works through the Techne
door and Aaron has decided on membership sync, remove the lane in one PR, with `REGENOS_LOGIN_ENABLED` and
`REGENOS_OAUTH_JWKS_URI`. Until then, `REGENOS_LOGIN_ENABLED=false` keeps it out of sight.
