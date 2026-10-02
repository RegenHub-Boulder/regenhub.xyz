# Issue #98 implementation report

Status: **independently additive protocol foundation only; issue #98 remains open.**
No existing web/bot writer is contained or migrated by this change. Do not deploy or activate this protocol as a global fix. No entrypoints were disabled. Implementation and verification used no production access, HA calls, real locks, production DB, secret-file reads, deployment, or merge. A fork PR is the deliverable; production cutover is not authorized.

Read `CLAUDE.md` and `README.md` before implementation. The full migration of the writer inventory below, transactional linkage to business rows, and a tested device drain/readback implementation are a separate required phase. Retrofitting a CAS after lock I/O does not solve this issue.

## Delivered independent part

- `packages/shared/src/doorSlotOwnership.ts`: opt-in `runReservedDoorOperation`, exported from shared. It awaits a committed DB reservation before dispatch, invokes the trusted callback once, and quarantines on both success and failure. Lost reserve response sends nothing. Failure to record quarantine leaves the durable pending reservation unavailable. Returns `verified: false` even on HA acknowledgement.
- `supabase/migrations/053_door_slot_ownership.sql`: additive registry for slots 1–200, authoritative door inventory, monotonic slot generation, globally unique operation UUID tombstones, and recovery audit ledger. All slots initially quarantined; no doors initially configured. No PINs stored in the registry. Legacy tables and policies are unchanged.
- Row locking serializes reservation. `free -> pending -> quarantined`; there is no lease, deadline, expiry, automatic takeover, replay, or HA-success release. A reused operation UUID is rejected even after recovery. Generations fence DB mutations; they cannot fence commands already accepted by HA or a lock.
- Ordinary `service_role` gets only reserve/quarantine RPC execution, with direct ledger writes revoked. Manual recovery is owner-only, requires the current generation, nonempty drain evidence, a barrier after the operation/quarantine, and fresh empty-slot readback attestations for exactly every configured door. Every door from the original operation must still be covered. RLS enabled with no end-user policies; default public function execution revoked.

This is intentionally a **one-command-per-slot-per-manual-recovery primitive**. It has no verified occupied state, normal regeneration/revocation path, or automatic reclamation. It is safe to add independently because it has no callers in existing runtime code, changes no legacy writer behavior, and makes no device calls. It is not a shippable complete door-code lifecycle. The SQL and full seed have now been executed against isolated PGlite 0.5.8 PostgreSQL. Independent read-only review verdict: **SHIP for the additive inactive foundation only** after fixing its blockers. **NO-SHIP for production remediation/cutover**; no production database or device was accessed.

## RED / GREEN evidence

Test was written and run before adding the new protocol implementation. Equivalent portable command (original captures used Node 26's `--test-isolation` alias):

```text
node --test --experimental-test-isolation=none packages/shared/test/doorSlotOwnership.test.ts
✖ an acknowledged clear must retain the slot while its device command is live
AssertionError: late clear erased new code; physicalCode=null
true !== false
pass 0; fail 1
```

Full captured output: [door-slot-red.txt](door-slot-red.txt). This invokes the actual old `allocateSlotWithRetry` implementation with a synthetic active-slot store: old code releases slot 101 on ACK; another owner allocates/programs it; queued old clear executes and erases the replacement. It models the writer/device interleaving, rather than invoking an actual production route or DB.

After implementation, the safety scenario uses the new reservation API and a synthetic DB contract model. The old unsafe allocator reproduction remains a separate passing test which explicitly asserts its unsafe outcome. It has **not** been repaired by this patch.

```text
node --test --experimental-test-isolation=none packages/shared/test/doorSlotOwnership.test.ts
✔ legacy allocator permits a late clear to erase a new code (retained reproduction)
✔ an acknowledged clear must retain the slot while its device command is live
✔ overlapping commands cannot dispatch while first command is suspended
✔ timeout or partial clear remains quarantined
✔ DB failure after I/O leaves pending and forbids takeover
✔ lost reserve response never dispatches or replays the permit
pass 6; fail 0
```

Full captured output: [door-slot-green.txt](door-slot-green.txt). Repeatable through shared `test:door-slots` on Node with native TypeScript support (tested Node 26.8.2; use Node 22.18+). The model starts free to represent prior authorized recovery. It does not test SQL privileges, row locks, restart durability, cross-process races, all-door evidence validation, or real HA readback. That original GREEN describes the client contract tests only. The review-blocker PostgreSQL suite below separately validates SQL behavior.

## Writer / allocator inventory

Paths are relative to repository root. Inventory was obtained by searching all apps, shared code, scripts and migrations for setters/clearers, allocation, PIN field mutation, and code activation changes; billing callers were traced separately.

| Entry point | Current path and mutation | Still requires global integration |
|---|---|---|
| Portal day-pass UI | `components/portal/DayPassRedemptionHero.tsx` / `api/portal/request-daypass/route.ts`: active-slot query, insert, set | Yes |
| Portal day-code revoke UI/API | `api/portal/revoke-code/route.ts`: clear, deactivate row | Yes |
| Portal permanent regenerate UI/API | `api/portal/regenerate-code/route.ts`: set, PIN update | Yes |
| Free-day claim UI/API | `api/freeday/activate/route.ts`: allocate/insert, set, claim linkage | Yes |
| Admin quick-code UI/API | `components/admin/QuickCodeForm.tsx` / `api/admin/quickcode/route.ts`: allocate/insert, set | Yes |
| Admin member create UI/API | `components/admin/MemberForm.tsx` / `api/admin/members/route.ts`: insert assigned slot/PIN, set | Yes |
| Admin member edit, upgrade, disable, delete | `api/admin/members/[id]/route.ts`: accepts explicit slot/PIN; own find-free helper; update, set/clear/delete | Yes, including direct requested slots |
| Admin lock sync UI/API | `components/admin/LockSyncSection.tsx` / `api/admin/lock-sync/route.ts`: set/clear every member slot, independent of generation | Yes; cannot serve as automatic recovery |
| Lock revoke API | `api/lock/revoke/route.ts`: clear, deactivate | Yes |
| Stripe billing | `api/webhooks/stripe/route.ts` -> `lib/membershipLifecycle.ts`: activate allocates/updates/sets; cancellation downgrade clears/releases | Yes |
| Past-due cron | `api/cron/past-due-sweep/route.ts` -> same downgrade helper | Yes |
| Onchain billing | `lib/onchain/verifyPayment.ts` -> same activation helper | Yes |
| Admin onchain membership | `api/admin/members/[id]/onchain-subscription/route.ts` -> same activation helper | Yes |
| Bot `/newcode` | `apps/bot/src/bot.ts` `handleNewCode` (~166) and `handleNewCodeFlow` (~810): set and PIN update; pending UI captures old slot | Yes; stale captured slot is dangerous |
| Bot day-pass | `handleDayPass` (~203–230): allocate/insert, set | Yes |
| Bot admin quick-code | `createQuickCode` (~646–671), expiration/flow callbacks: allocate/insert, set | Yes |
| Bot revoke callback | `handleRevokeCallback` (~686–699): clear/deactivate | Yes |
| Bot admin create member | `createMember` (~901–924): allocate/insert, set | Yes |
| Bot change member tier | `handleChangeToCallback` (~1052–1097): allocate/set, failed-set rollback releases slot, downgrade clear/releases | Yes; rollback is unsafe if commands may remain live |
| Bot startup and five-minute scheduler | `apps/bot/src/scheduler.ts` `expireOldCodes`: clear/deactivate even on partial clear | Yes |
| Shared direct HA writers | `packages/shared/src/homeAssistant.ts` `setUserCode` / `clearUserCode`: retries + delayed resend | Yes; retries/resends are additional potentially live commands |
| Shared allocator / bot helper | `packages/shared/src/slotAllocation.ts`; `apps/bot/src/helpers/slotManager.ts` is an obsolete/comment-only helper | Replace allocation contract globally |
| Direct SQL / Supabase writes | `members.pin_code_slot`, `members.pin_code`, `members.disabled`, row deletion; `day_codes.pin_slot`, `code`, `is_active`, deletion | Still bypass registry entirely |
| Database constraints / privileges | Migrations `001`, `003`, `006`, `010`, `018`, `031` and service-role bypass/RLS; unique indexes constrain business rows only | Need trigger/privilege fencing plus ownership linkage |
| Operations MCP migration runner | `lib/mcp/migrationTools.ts` / `lib/migrations.ts` executes privileged migration SQL; no PIN allocator RPC found in existing migrations | Privileged SQL remains trusted bypass; audit/manual policy required |

UI display-only components and `api/access-events/route.ts` read codes/slots and do not program codes. They will still need desired-vs-verified status/attribution updates in the complete design. Door hold/unlock/lock functions and bot `doorHolds.ts` operate bolt state, not user-code slots; they must be included in a maintenance shutdown but are not slot allocators. No additional repository SQL allocation function was found; direct SQL row assignments are allocation regardless of whether they call the retry helper.

## Gates and baseline environment

Dependencies were installed by the parent using `pnpm install --frozen-lockfile --ignore-scripts`. They were not reinstalled or removed during this review fix. No dependency or lockfile change was needed for the external PostgreSQL harness.

| Gate | Verified result |
|---|---|
| Web tests | PASS: 45 files, 323 tests |
| Web lint | PASS (`pnpm --filter web lint`) |
| Web build | PASS (`pnpm --filter web build`; missing optional env warnings only) |
| Bot build and tests | PASS: TypeScript build and 12 tests |
| Shared build | FAIL: 16 pre-existing diagnostics, exactly reproduced on upstream main; no new diagnostics. Supplemental `tsc --noEmit --typeRoots ../../apps/bot/node_modules/@types` PASS |
| Web typecheck | FAIL: 30 pre-existing diagnostics (upstream baseline has 42 before Next generated declarations); no new diagnostics |

All canonical gates were exercised directly; none is inferred from focused tests. Baseline diagnostics were reproduced in an isolated worktree at upstream `6cd7d14`. No unrelated typecheck cleanup is included.

## Review blocker tests and fixes

Tests were added and executed before production edits. [Review RED](door-slot-review-red.txt) records four failures: mutable operation identity, post-seed grants, arbitrarily old initial recovery, and multidimensional evidence. [Review GREEN](door-slot-review-green.txt) records the final focused run: **11 passed, 0 failed**, including four isolated PostgreSQL tests. `git diff --check` also passed.

Repeat from the repository root with Node native TypeScript support (Node 22.18+):

Client suite: `pnpm --filter @regenhub/shared test:door-slots`. For the SQL suite, first install the external pinned harness and set `PGLITE_MODULE` as shown below.

The harness imports PGlite through `PGLITE_MODULE` (or package resolution when already installed). It does not hardcode an agent workspace or use a remote DB. For a reproducible scratch installation, on a machine with package access:

```sh
PG_TEST_DIR="${TMPDIR:-/tmp}/issue98-pg-test"
npm install --prefix "$PG_TEST_DIR" --no-save --package-lock=false --ignore-scripts @electric-sql/pglite@0.5.8
PGLITE_MODULE="$PG_TEST_DIR/node_modules/@electric-sql/pglite/dist/index.js" node --test --experimental-test-isolation=none packages/shared/test/doorSlotOwnership.test.ts packages/shared/test/doorSlotPostgres.test.mjs
```

The parent installed the pinned PGlite package in a disposable scratch directory; the actual PostgreSQL tests and reviews are offline. Each SQL test creates and closes its own in-memory PostgreSQL instance, creates synthetic Supabase roles (including BYPASSRLS service role), executes the actual migration and seed, and uses synthetic door inventory. It tests post-seed table/sequence privileges and denied writes/recovery, permitted service RPCs, initial/current timestamp bounds, malformed/missing/duplicate/exact-door evidence, stale/current generations, replay after recovery, rollback, and competing reservations. PGlite has a serial single connection: simultaneous promises prove competing requests fail closed, **not independent multi-connection row-lock contention**. Multi-connection PostgreSQL contention and restart persistence remain future cutover validation.

Seed explicitly reapplies foundation revokes after blanket grants. Initial quarantine persists `recovery_not_before`; entering quarantine advances it, while repeated quarantine does not weaken it. Recovery requires a barrier at or after that bound and the operation bound. Identity is copied before the first await, and dispatch receives a frozen `ReservedDoorOperation` containing slot, owner, operation, action and generation. Quarantine always uses that original identity. The callback is trusted: it must use the supplied identity, send once, and must not retain or replay it. The wrapper cannot constrain arbitrary callback closures or fence a queued physical command.

## Manual recovery design (future authorized maintenance only)

1. Establish physical fallback access and an approved maintenance window. Stop **every** sender: web replicas, bot/poller, startup/five-minute scheduler, billing and cron invocations, lock sync, operators/direct SQL, and any external HA automation/scripts that write user codes. Disable automatic restart and scheduled delivery. Keep the authoritative target inventory, including retired/unreachable doors.
2. Prove old commands cannot execute later. This includes paused workers, HTTP retries, HA service tasks, Z-Wave queues and controller/device commands. A timeout, process lease expiry, restart, HTTP 200, or successful readback while an older command remains queued is insufficient. Record an actual drain/cancellation/isolation procedure and evidence. If that cannot be established, retain quarantine indefinitely. Replacement/reset and controlled re-enrollment may be needed; do not guess a wait interval.
3. Inspect the exact slot/generation/operation and reconcile desired business ownership. Convert a pending slot to quarantine with its current token only after dispatchers are stopped. This does not cancel a device command. Do not resume an old permit.
4. With senders stopped and old commands drained, clear the slot through a controlled maintenance procedure. Finish/drain that maintenance command too. Obtain fresh, device-originated **empty user-code-slot** readback from every inventoried door after the final barrier. Cached HA state, health sensors, ACKs and re-sends are not proof. Do not record PINs in evidence. If any door is unknown, unreachable, occupied or unsupported, stop and retain quarantine.
5. Privileged DB owner may invoke `door_slot_recover(slot, expected_generation, drain_evidence, barrier_at, entities, empty_readback_at)`. The last array is an operator attestation of verified empty-slot reads; DB cannot authenticate physical evidence. Normal service-role writers cannot invoke recovery. Capture operation-specific queue-drain evidence and per-door readback provenance in an external restricted audit record, referenced by drain evidence. SQL validates coverage/times, not physical truth.
6. Verify the recovery audit and free state before an entirely new operation UUID/generation. If interrupted or uncertain at any step, retain reservation/quarantine. Do not reuse an old operation or delete its tombstone. Restore senders only after global cutover prerequisites below are satisfied.

## Staged cutover design / remaining work

1. Review this inactive foundation independently; execute migration and privilege/concurrency tests against an isolated synthetic PostgreSQL database. The isolated migration/seed and focused regression tests now run locally. Before cutover, additionally validate independent multi-connection races and persisted restart state on standalone PostgreSQL.
2. Design the full owned/verified lifecycle with atomic business-row ownership linkage and an operation outbox. Allocation must reserve slot and link the member/day-code within one DB transaction, across both web and bot and direct SQL. Define authoritative ownership, PIN version and action transitions. Keep quarantined slots unavailable even when business rows are inactive/deleted. Refunds, billing retries, business rollback and expiry must not free physical reservations.
3. Implement a single fenced dispatcher boundary. Prevent duplicate dispatch of a consumed permit; persist intent before I/O; never let a resumed old process send after recovery. Where physical fencing is unavailable, any uncertain command blocks later programming until the manual drain barrier. Post-I/O CAS cannot repair a stale clear or set that already hit a lock. Add a tested device-specific fresh readback/drain adapter; no assumptions about HA response shape or queue lifetime.
4. Migrate **all inventory rows** in one coordinated release plan, including admin explicit slots, lock sync, both bot new-code forms, bot failure rollback, scheduler startup, billing and direct SQL. Add DB triggers/privilege controls to reject naked business-table slot/PIN ownership mutations. Fail closed if schema/protocol version mismatches. Do not switch a subset and claim containment.
5. Stage artifacts while inactive. In an authorized maintenance window, globally pause/drain old senders; configure all doors; import occupied and orphaned slots conservatively as quarantined; reconcile business rows and physically verify them. Retain reservations for unverifiable/retired doors. Initial registry quarantine is deliberate, not a reason to mass-mark free.
6. Enable the complete protocol only after old binaries/credentials, pending bot actions, external scripts, queues and migration/direct SQL bypasses are fenced and the offline regression/gates pass. Read-only UI should distinguish desired code from verified access. Rollback must keep DB reservations and keep old writers stopped; reverting binaries to legacy writers is unsafe.

Residual risks: all existing code writers are still vulnerable; PGlite tests use a serial connection and do not establish independent connection contention or restart durability; no verified-occupied state or usable normal multi-operation lifecycle; no physical fencing/drain/readback implementation; no DB triggers fencing legacy direct SQL; no transactional business-row integration; no production device end-to-end test; canonical shared build and standalone web typecheck retain pre-existing failures documented above. This part must not be described as closing #98.

Independent read-only review first returned NO-SHIP, identifying seed privilege leakage, old initial recovery timestamps, mutable caller identity, and missing SQL execution. All were fixed with RED/GREEN tests. Re-review returned SHIP for the inactive foundation, 11/11 tests passing; complete issue #98 remediation remains NO-SHIP and the issue stays open.

## Repeatable consequential legacy RED probe

The legacy reproduction invokes the unchanged real allocator and a synthetic queued device clear. Apply the safety assertion instead of its normal known-bug expectation:

```sh
DOOR_SLOT_LEGACY_RED=1 node --test --experimental-test-isolation=none --test-name-pattern="legacy allocator" packages/shared/test/doorSlotOwnership.test.ts
```

Verified exit 1: the late clear erases the replacement (`physicalCode=null`). The normal foundation + SQL suite exits 0 with 11 passing tests. This probe intentionally still fails because legacy integration is deferred, not silently claimed fixed.
