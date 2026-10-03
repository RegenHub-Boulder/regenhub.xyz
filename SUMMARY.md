# Issue #98 — SMALL PR 1

Implemented on `fix/lock-slot-quarantine`. Reference: https://github.com/RegenHub-Boulder/regenhub.xyz/issues/98 and the unchanged, untracked `DESIGN-98.md`. This is the smaller quarantine/serialization change, not DESIGN-98's executor/queue design. No migration, deployment, push, or PR creation was performed. No production, regenhub.xyz, LAN, or HA endpoint was contacted by the implementation or tests; HA tests use mocked fetch/invalid test hostnames. No secrets were inspected and no `.env` files were edited. `pnpm-workspace.yaml` has no final changes.

## Serialization choice

One durable **non-expiring writer reservation** covers the entire PIN pool across web and bot. This is intentionally more conservative than separate per-slot leases: it serializes allocation, regeneration, revoke, member deletion, policy changes, Lock Sync and multi-slot admin edits without holding a Supabase transaction across HA or adding a dedicated executor. The database CAS acquisition is a SECURITY DEFINER RPC. A second request waits up to about ten seconds, then fails closed if still busy. The reservation stays held through database mutations, all configured doors, transport retries, the three-second resend delays, and completion/compensation. Ordinary completion releases it in `finally`.

The reservation does **not** expire or get stolen. Therefore a paused/crashed old worker cannot resume after an automatic lease takeover and clear a newly allocated PIN. A crash or uncertain acquisition/release RPC can leave all PIN operations blocked until an operator fences the old processes and recovers the reservation. This availability tradeoff is deliberate; an age-based takeover would reopen the check/send race.

The shared helper carries the private reservation token through AsyncLocalStorage. Server-side Supabase fetch adds it as `x-lock-writer-token`. Database triggers require a matching live token for PIN/slot/access-state mutations and reject allocation into quarantined slots, including explicit admin slot edits. Existing balance/profile updates that do not affect PIN access remain usable. The shared HA transport checks the reservation **and re-reads a fingerprint of the current slot owner before every door write and every retry/resend**. Bot pending flows and billing helpers re-read current slot ownership after acquiring, rather than using old conversation/billing slot snapshots.

A quarantine marker is committed **before** CLEAR or SET transport. Partial results, missing configured-door results, health warnings, throws and timeouts retain quarantine. A failed/timed-out CLEAR attempt remains uncertain even if its internal retry later receives an acknowledgement; a separate clean all-door retry is required. CLEAR succeeds only with a clean success for every configured HA_LOCK_ENTITIES door, including completion of both sends. Only that path removes clear quarantine. An initial clean SET removes its own interrupted-SET marker; a SET of a previously quarantined slot never releases the existing quarantine. Allocators consult the quarantine RPC, and a database trigger provides a second allocation guard. Removing an ownership pointer without a recorded successful clear creates an ownerless quarantine, so SET-error compensation cannot silently recycle a possibly programmed slot.

## Per-file changes

Paths below are repository-relative.

| File | Change |
| --- | --- |
| `packages/shared/src/lockSlotSafety.ts` | Durable reservation wrapper, request-token propagation, owner fencing, quarantine persistence and all-door clear/release helper. |
| `packages/shared/src/homeAssistant.ts` | Guarded public PIN SET/CLEAR; per-attempt fencing, pre-I/O quarantine, all-door clear requirement; ten-second HTTP timeouts, including health reads. Existing retry/resend behavior remains awaited. |
| `packages/shared/src/slotAllocation.ts` | Adds quarantined slots to the used set on every allocation attempt. |
| `packages/shared/src/index.ts` | Exports the shared safety helpers for both apps. |
| `packages/shared/package.json` | Declares Node types already needed by shared crypto/process usage and now AsyncLocalStorage. |
| `apps/web/src/lib/lockWriter.ts` | HTTP wrapper around shared reservation; busy/DB failures return 503. |
| `apps/web/src/lib/supabase/admin.ts` | Propagates reservation token on service-client database requests. |
| `apps/web/src/lib/supabase/server.ts` | Propagates reservation token on cookie-client database requests, including portal revoke. |
| `apps/web/src/lib/membershipLifecycle.ts` | Serializes billing activation/downgrade (W11/W12), reads current slot, preserves slot/PIN on uncertain revoke, reports `revokedSlot=null` on failure. Billing still cannot undo admin disable. |
| `apps/web/src/app/api/admin/quickcode/route.ts` | W1 creation, allocation, HA and compensation share reservation; failed SET compensation retains durable quarantine. |
| `apps/web/src/app/api/portal/request-daypass/route.ts` | W2 balance/allocation/HA/compensation share reservation; uncertain SET cannot recycle its slot. |
| `apps/web/src/app/api/freeday/activate/route.ts` | W3 claim/allocation/HA/compensation share reservation; uncertain SET cannot recycle its slot. |
| `apps/web/src/app/api/lock/revoke/route.ts` | W4 snapshot/clear/deactivation are serialized; shared partial clear now throws before deactivation. |
| `apps/web/src/app/api/portal/revoke-code/route.ts` | W5 ownership check/clear/deactivation are serialized; uncertain clear retains active assignment and quarantine. |
| `apps/web/src/app/api/portal/regenerate-code/route.ts` | W6 eligibility read/HA/PIN update share reservation. |
| `apps/web/src/app/api/admin/members/route.ts` | W7 permanent allocation/insert/HA share reservation. |
| `apps/web/src/app/api/admin/members/[id]/route.ts` | W8/W9 edits and deletes share reservation; allocator skips quarantine; old slot is cleared before moving/removing it or downgrading; uncertain deletion clear retains member and slot. Disable-clear failures remain quarantined. |
| `apps/web/src/app/api/admin/members/[id]/revoke/route.ts` | W13 admin disable/provider cancellation is serialized with PIN operations. No new billing/disable policy was added. |
| `apps/web/src/app/api/admin/lock-sync/route.ts` | W10 entire snapshot/sync shares reservation; skips quarantined slots and reports them failed so sync cannot revive their PINs. Explicit retry-clear handles recovery. |
| `apps/web/src/app/api/admin/lock-quarantine/route.ts` | Admin-only retry clear with fresh owner snapshot; releases business pointers only after all-door success. Supports member, day-code and ownerless quarantine. No force-free action. |
| `apps/web/src/components/admin/QuarantinedSlots.tsx` | Quarantine count, slot, reason, timestamp, retry-clear action and failure feedback. |
| `apps/web/src/app/admin/access/page.tsx` | Service-side quarantine reads in existing Lock Sync tab; shows an outstanding writer's acquisition time without exposing its token. |
| `apps/bot/src/db/supabase.ts` | Propagates the same reservation token on bot database requests. |
| `apps/bot/src/bot.ts` | B1–B6 PIN commands/callbacks/creation share reservation; pending flows use current member slot/type; uncertain revoke/downgrade no longer release pointers or claim success; SET compensation keeps quarantine; busy operations return a useful bot message. |
| `apps/bot/src/scheduler.ts` | B7 expiry snapshot/clear/deactivation share reservation; clear failure retains active code; checks DB errors; scheduler catches reservation failures. Injectable client/clear adapter supports offline tests. |
| `apps/web/src/lib/lockSlotSafety.test.ts` | Tests written first: partial/throw/timeout quarantine, full clear/retry, allocation exclusion, overlapping clear/resend versus allocation, and unguarded write rejection. |
| `apps/web/src/lib/homeAssistantSlots.test.ts` | Mocked HA tests for partial, timeout, recovered timeout, throw, health warning, full all-door resends and ownership change before stale resend. |
| `apps/web/src/lib/lockSlotMigration.test.ts` | Runs migration twice in isolated PGlite PostgreSQL; tests competing reservation tokens, header guards, allocation rejection, safe release, ownerless quarantine and table/RPC grants for anon/authenticated/service_role. |
| `apps/web/src/app/api/admin/lock-quarantine/route.test.ts` | Route-level partial/throw/full-success retry tests; non-admin and non-quarantined requests cannot write HA. |
| `apps/bot/src/scheduler.test.ts` | Bot expiry partial/throw/full-success tests with mocked clear transport; checks quarantine and deactivation together. |
| `apps/web/src/lib/membershipLifecycle.test.ts` | Uses real reservation helper with mocked DB/HA; adds failed downgrade/stale-caller-slot regression. |
| `apps/web/src/app/api/admin/members/[id]/route.test.ts` | Uses real reservation helper; adds member retention on failed clear. |
| `apps/web/src/app/api/freeday/activate/route.test.ts` | Preserves real shared reservation exports while retaining existing HA/allocation stubs. |
| `apps/web/src/app/api/portal/regenerate-code/route.test.ts` | Preserves real shared reservation exports and supplies service DB for wrapper. |
| `apps/web/src/lib/billingDisabled.test.ts` | Existing stateful billing DB fake now supports reservation/quarantine RPC reads. |
| `apps/web/test/mockSupabase.ts` | Shared mock supports reservation/check/release and empty quarantine list by default. |
| `apps/web/package.json` | Adds test-only PGlite dependency for real SQL/RLS/grant validation without a live database. |
| `pnpm-lock.yaml` | Only the PGlite dependency and shared Node-types declaration; no unrelated version updates. |
| `supabase/migrations/053_lock_slot_quarantine.sql` | Migration described below. |

W14 and billing adapters do not directly mutate slots; their activation/downgrade calls enter the guarded lifecycle helper. Door-hold/bolt/automation operations are not PIN-slot writers. `DESIGN-98.md` remains unchanged and untracked. This `SUMMARY.md` remains untracked by request.

## Migration

Highest existing migration was **052**. New file: **`supabase/migrations/053_lock_slot_quarantine.sql`**.

- Creates `lock_slot_quarantine(slot primary key, reason, quarantined_at, door_results)` and singleton `lock_slot_writer(id, token, acquired_at, cleared_slots)` with `if not exists`.
- Enables RLS on both, revokes PUBLIC/anon/authenticated privileges, grants service_role SELECT only; mutations use service-only SECURITY DEFINER RPCs with pinned `search_path`.
- Provides atomic acquire/check/release, owner fingerprint, quarantine/list/release and initial-SET-marker completion RPCs. Revokes public/anon/authenticated execution and grants execution only to service_role.
- Adds idempotently replaced guards on `members` and `day_codes`. Legacy/unwrapped PIN writers are rejected; quarantined slots cannot be newly claimed; uncertain pointer removal records quarantine rather than silently making a slot reusable.
- Creates no reservation/quarantine rows until an operation uses the protocol. No owner/access backfill, PIN changes, member changes or day-code changes occur during migration.

Expected SHA-256: `91bf129053b28aa42ec691d9c308f720870157f97ed1b6e41e7aa575d6066d5b`.

## Validation counts

| Check | Before | After |
| --- | --- | --- |
| Web `pnpm test` | 47 files / **333 passing tests** | 51 files / **356 passing tests** (+23) |
| Bot `pnpm test` | **12 passing tests** | **15 passing tests** (+3) |
| Web `pnpm lint` | **0 errors, 2 warnings** | **0 errors, same 2 warnings** |
| Shared build | Initial checkout lacked shared dist and declared Node types | `pnpm --filter @regenhub/shared build` passes |
| Bot typecheck/build | — | `pnpm build` in `apps/bot` passes |
| `git diff --check` | Clean initial tracked diff | Passes |

The first web run before shared build had 314 passing tests and four import-failed files because `@regenhub/shared/dist` was absent. The comparable 333-test baseline was then run from a temporary HEAD archive using a built **baseline** shared package, isolated from the new implementation. The first safety test was run while its implementation module was absent and failed; it passed after implementation. All HA tests mock transport; migration testing uses an in-process database with synthetic members/codes and roles.

Optional standalone web TypeScript check remains at **45 pre-existing diagnostics before and after**, with identical messages except shifted line numbers. These concern existing static-asset declarations, ES2017/BigInt tests and old test typings; no new diagnostics were added. This was not a requested web gate. A root build was inadvertently invoked and stopped during compilation; it did not finish and is not reported as validation.

## Explicit remaining limits

- **No physical readback of lock slots.** HA HTTP acknowledgement plus clean cached health is the SMALL criterion, not proof of physical PIN removal. No hardware capability claim or exercise was made.
- No device-side fencing token, queue drain/readback protocol, or guarantee against HA/Z-Wave replay/reordering after an acknowledged/timed-out command. The reservation prevents overlapping application writers; it cannot recall commands already accepted by HA. Operational recovery must fence old processes and resolve outstanding transport work before resetting a stuck reservation.
- The global reservation reduces throughput. Slow HA blocks every PIN writer; a crash can block all PIN writes indefinitely. There is no lease TTL, automatic takeover, or automatic crash recovery. Admin retry cannot bypass a held reservation.
- No executor, durable intent queue, per-door physical evidence ledger, automatic SET retry daemon, or full DESIGN-98 state machine.
- No legacy orphan-slot/historical-inactive-code backfill. Existing unknown hardware state is unchanged. Previously issued PINs are not cleared by migration.
- Partial/failed SET can still leave a business row active or an operation compensated according to its existing caller behavior; quarantine prevents reuse, but this PR does not make issuance, claim linking, debit/refund, notification or provider effects exactly-once.
- No broader entitlement redesign: stale subscription eligibility, old provider events, multiple subscriptions, complete disable/delete revocation of associated day codes, and W13's existing on-chain cancellation policy are outside this change.
- Database tests exercise real PostgreSQL semantics in PGlite, not a full deployed Supabase/PostgREST stack. Token-header behavior and role setup should be verified in isolated staging before cutover. No browser interaction/visual test or full production build was completed.
- Old binaries/direct external HA clients do not honor this reservation. All old web/bot workers must be stopped/drained during cutover; the database guards alone cannot fence their raw HA transport.

## Exact production migration/cutover steps (instructions only)

These steps require a separately authorized production maintenance window. Nothing below was executed in this task. Use existing managed credentials/configuration; do not paste secrets into commands or edit `.env` files.

1. Review this commit and the limitations above in isolated staging first. Obtain the production go and ensure a database backup/restore point exists.
2. Pause **all** PIN writer entrypoints: admin/member PIN routes and Lock Sync, free-day activation, Stripe/on-chain access effects, past-due sweep, and bot PIN callbacks/startup/expiry scheduler. Stop/drain every old web/bot worker and in-flight HA retry/resend. Keep the migration MCP endpoint available. Confirm no old process can resume sending PIN commands; unresolved old transport work blocks cutover.
3. Deploy the reviewed web image containing `053_lock_slot_quarantine.sql`, with PIN routes/cron access effects still paused and the bot still stopped. Do not permit old and new PIN writers to run together. New PIN operations fail closed until RPCs exist; the admin Access page also requires the new tables.
4. Using the existing RegenHub operations MCP with the `migrate` scope, call **`list_migrations({})`**. Require the ledger to exist, migrations through 052 to be applied, no checksum drift, and `053_lock_slot_quarantine.sql` to be the lowest pending file. If not, stop and resolve prerequisites under separate authorization; do not skip earlier migrations or invent baseline rows.
5. Call **`run_migration({"filename":"053_lock_slot_quarantine.sql"})`** exactly once. The existing runner executes the file and ledger insert in one transaction; any failure rolls both back. Require success and the SHA-256 above.
6. Call **`list_migrations({})`** again. Require 053 to be applied with that checksum, no drift, and no 053 pending. In the authorized SQL console, verify without changing access:

   ```sql
   select relname, relrowsecurity
   from pg_class
   where oid in ('public.lock_slot_quarantine'::regclass,
                 'public.lock_slot_writer'::regclass);
   select count(*) from public.lock_slot_quarantine;
   select count(*) from public.lock_slot_writer;
   select tgname from pg_trigger
   where not tgisinternal
     and tgname in ('guard_member_lock_slot','guard_day_code_lock_slot');
   ```

   Both RLS flags must be true; both tables should be empty immediately after the paused, no-backfill migration; both triggers must exist. If counts are nonzero, investigate the writer pause rather than deleting rows.

7. Deploy/start the matching bot build (including rebuilt `@regenhub/shared`) and confirm only the reviewed web/bot versions remain. Under separately approved canary access testing, verify header propagation, quarantine visibility and an all-door retry-clear. A failed door must leave quarantine and prevent reuse. Do not interpret a successful API response as physical readback.
8. Resume paused writers only after the staged checks pass. Monitor quarantine rows and any reservation that remains after its request finishes. Keep the additive schema on rollback; stop PIN writers rather than restoring raw legacy writers.

If the migration MCP is not configured or lacks the `migrate` scope, stop; an operator must establish the authorized migration connection/workflow. Do not use `supabase db reset` in production.

### Stuck reservation recovery

There is deliberately no force-free button. Stop/fence **all** PIN writers first and prove the old reservation holder cannot resume and outstanding HA/Z-Wave writes cannot replay. If that cannot be established, keep the reservation/quarantines and escalate to the authorized operator. With those conditions met, an authorized database administrator may delete **only** the reservation row while writers are stopped:

```sql
delete from public.lock_slot_writer where id = 1;
```

Never delete `lock_slot_quarantine` rows to make slots free. Restart only updated writers, inspect the quarantine list, and use **Retry clear** for each affected slot. Each retry independently requires every configured door to report clean success before removing quarantine and releasing its business assignment. An offline/failed door keeps the slot held.

## Follow-up commit

Follow-up for #98 after independent SHIP review: web handlers now authorize and perform pure request validation before acquiring the global PIN writer reservation. Ownership/eligibility reads, allocation and mutations remain inside it. Regression coverage rejects unauthenticated requests across all 12 handlers and non-admin requests across all 8 admin handlers without any reservation RPC, plus four invalid-input cases.

Access / Lock Sync now shows the reservation holder label and age, warns in red after two minutes, and points to the recovery procedure copied into DEPLOYMENT.md under “Door-code writer reservation.” Migration 054 adds safe holder labels for web, bot and scheduler; it preserves held reservations and introduces no expiry or force-free action. Deploy migration 054 before updated writers and rebuild shared first.

Validation: web 53 test files / 384 tests passed; lint 0 errors / 2 existing warnings; bot 15 tests passed and build passed; shared build passed. `git diff --check origin/main..HEAD` passed. All work stayed local; no network, production, secret access, .env edits or pnpm-workspace.yaml changes. No push.
