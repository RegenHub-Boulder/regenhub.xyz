# Sign in with Techne on regenhub.xyz (T-482, part 2)

One door for Techne: a member RSVPs and a steward manages RegenHub's calendar with the same "Sign in with
Techne" session. Supabase email login stays the door for billing and the portal. Written 2026-11-17 from the
public docs only (techne.computer/llms.txt and what it lists, reference.html, techne.pub, the lexicons in npm
`techne-sdk@0.4.0`) and read-only calls to the live platform.

## What changed

- `/portal/events` no longer uses the old regenOS lane (scenius cookie, magic link, `/xrpc` proxy). A steward
  signs in with Techne, the same client and session as RSVP (`components/techne/useTechneSession.ts`).
- The calendar on that page is the documented public read every visitor gets.
- Steward or not comes from the collective's public membership claims (below).
- Posting, editing and cancelling are **off**: Techne documents no way for an app to write a public record as
  a collective. `ManageEvents` takes a `write` seam; it is `null`, and the page says why and lists the confirmed
  nights not yet posted. When Techne answers, the seam gets one implementation and the scope list one entry.
- `TECHNE_RSVP_ENABLED` is renamed `TECHNE_SIGNIN_ENABLED` (it now covers both pages). It was off in production.

## Study, with sources

### Writing a public `community.lexicon.calendar.event` as the collective: not documented

- Public records go to the signed-in person's **own** repo: "Write into the user's repo, on their PDS"
  (docs/building-an-app.md, *Write*); "A public record goes through `com.atproto.repo.putRecord` on the PDS"
  (building-an-app.md, *Private and shared data*); reference.html, *Write and read records*, `repo.putRecord`:
  scope `repo:<collection>`. A PDS session writes only that person's repo. RegenHub
  (did:plc:dl3lexgjfg2euvkqvao4wsgs, PDS pds.techne.town) is a separate account whose credential the platform
  holds.
- The one documented write *as a collective* is `pub.techne.draft.permissioned.putRecord`: "Write one record into
  your own repo (or a collective's or circle's whose own member space you manage)" (reference.html, *Write and
  read records*). It is the permissioned write: `space` is required, and "Public records are written with
  com.atproto.repo.putRecord, not here" (the method's lexicon, `space`). So the collective's pen is handed over
  for space-bound records only.
- techne-sdk's `put` writes to the signed-in DID. `connectHosted` relays the platform's
  `com.atproto.repo.applyWrites` "to the repo's PDS with the credential it holds", but it is for apps whose OAuth
  client is the platform, and nothing says it takes a collective as `repo`.
- Edits and deletes have the same gap.
- What the platform does today (undocumented for apps): the collective's events have `ev-…` keys and a
  collective-authored `pub.techne.draft.event.listing` at `{rkey}-ctx`, which the old
  `social.scenius.createEvent` writes. Those methods are not in techne-sdk 0.4.0 and not on reference.html.

### Scopes

- Today: `atproto`, `repo:community.lexicon.calendar.rsvp`, and techne-sdk's defaults (`authPermissioned`, the
  app's own private space, `rpc:` for the generic reads and `sync.indexRecord`) — building-an-app.md
  *Permissions*; techne-sdk/auth `scopes()`. Consent shows the community banner for "public records plus the
  app's own space", not the red warning.
- Stewards need nothing more until the write is known: their check is a public read. The write will add one
  scope (`repo:community.lexicon.calendar.event` if it goes through the steward's PDS, or an
  `rpc:<method>?aud=did:web:techne.computer%23atproto_appview` for a platform method). Metadata and `signIn` must
  name the same list (techne-sdk/auth: "the PDS refuses a request beyond what the metadata declares"), so adding
  it asks everyone to consent again.

### Who stewards RegenHub

- `pub.techne.draft.membership` is "a statement by a collective that someone holds a role in it … Authored ONLY
  by the collective … (today 10=member, 20=builder, 30=facilitator, 40=steward) … End a membership with
  validUntil" (`registry.getType?nsid=pub.techne.draft.membership`). Its query document maps `subject` to the
  `references` role as `at://{did}`.
- Read: `query.listRecords` `{type is pub.techne.draft.membership, author is <collective>, references is
  at://<did>}` — public, no sign-in (reference.html *Query*; building-an-app.md *Read*). The DID comes from the
  person's Techne session. `lib/techne/standing.ts` counts only claims in the collective's own repo about exactly
  that DID, inside `validFrom`/`validUntil`, and takes the highest role. Builder (20) and up may manage, the bar
  of the old `createEvent` gate and of the event-detail space's `memberRole atLeast: 20` (docs/spaces.html).
- Live, 2026-11-17: RegenHub has one public membership, `unforced.techne.town`, role 40.
- Limit: a claim the collective placed in its member space is invisible to this read and to the default scopes
  ("The platform narrows the queries to public data and the app's own space", building-an-app.md *Permissions*).
- This check only decides what the page shows. The platform checks every write itself.

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

## Design for posting, and the question for Lucian

The page, the form, "Add the next nights", TID keys, `America/Denver`, the series names: all built and unchanged.
Only the transport is missing. Three shapes, in the order we'd like them:

1. **A documented platform method** that writes the event (and its `event.config` `{rkey}-cfg`, and the
   collective's `event.listing` `{rkey}-ctx`) into the collective's repo for a caller holding builder or above,
   called through the steward's PDS with an `rpc:` scope. Closest to today's data.
2. **`com.atproto.repo.applyWrites` at the platform with `repo` = the collective**, the hosted door, reachable
   from a third-party OAuth app's session.
3. **The steward's own repo**: `put` the event as the steward (documented today), and the collective lists it with
   an `event.listing`. The listing is still a write as the collective, so this needs (1) or (2) for one small
   record; and other Techne apps would show the steward, not RegenHub, as host.

The question:

> A steward of a collective (role 40 in RegenHub, did:plc:dl3lexgjfg2euvkqvao4wsgs) is signed in to a
> third-party app (client id `https://regenhub.xyz/techne/client-metadata.json`) with techne-sdk/auth. How does
> the app create, edit and cancel a **public** `community.lexicon.calendar.event` authored by the collective, and
> which scope does the sign-in request for it? `permissioned.putRecord` hands over the collective's pen only for
> space-bound records, and `repo.putRecord` writes only the steward's repo. Is it one of the three shapes above,
> or something else? And does `social.scenius.createEvent/updateEvent/deleteEvent` stay after the release?

Two smaller ones: how does an app learn a role the collective keeps in its member space, without `authRead`; and
is the bar for event writes builder (20) or the member space's manage leg (facilitator, 30)?

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
`lib/regenos/auth.ts`) and `/admin/members` membership sync. Proposal: once posting works through the Techne door
and Aaron has decided on membership sync, remove the lane in one PR, with `REGENOS_LOGIN_ENABLED` and
`REGENOS_OAUTH_JWKS_URI`. Until then, `REGENOS_LOGIN_ENABLED=false` keeps it out of sight.
