# Issue #97 — newsletter claims and recovery

Local branch: `fix/newsletter-claim`. No push, PR, production access, provider calls, migration application, or environment-file edits. GitHub reads were limited to the issue and PR comments explicitly requested. Autosend remains OFF by default and `force` still cannot bypass its gate. `pnpm-workspace.yaml` is unchanged.

## Per-file changes

- `apps/web/src/lib/newsletterSend.ts`: issue run lease; recipient claim RPC before provider I/O; persisted provider payload and stable `newsletter:<issue-id>:<recipient-row-id>` key; token/status-fenced completion with affected-row checks; definitive failures require explicit retry; unknown acceptance retains its lease. Progress reports active/unknown rows and pages the ledger to avoid PostgREST truncation.
- `apps/web/src/lib/email.ts`: Resend SDK idempotency option; message-id recording; transport errors, missing message ids, and unrecognized provider errors are ambiguous rather than terminal.
- `apps/web/src/app/api/admin/newsletter/send/route.ts`: delegates locking and finalization to the shared engine; removes unfenced issue updates.
- `apps/web/src/app/api/admin/newsletter/prepare/route.ts`: only unfrozen drafts can prepare; database freeze conflicts return 409.
- `apps/web/src/app/api/admin/newsletter/draft/route.ts`: rejects sending/frozen issues; database edit-vs-send fencing returns 409.
- `apps/web/src/app/api/cron/newsletter/route.ts`: removes the independent provider loop and admin-actions claim. Reuses the issue key, preserves existing admin drafts, prepares through the shared RPC, and drains shared batches until finished, quota/rate limit, an active/unknown delivery, or another worker owns the run. New cron issues use the compiled text as their Markdown revision. Note consumption is conditional on the stored note matching the compiled note.
- `apps/web/src/lib/newsletterSend.test.ts`: 16 Supabase/provider mock tests covering a concurrent pending set, crash after acceptance with provider deduplication, identical retry payload/key, one ledger completion, fresh/stale claims, expired retention, lost tokens, frozen content, admin+cron coexistence, autosend gating, terminal-only retry, active-run retry exclusion, and preparation RPC.
- `apps/web/src/lib/emailIdempotency.test.ts`: 7 provider adapter tests covering SDK options/message id and ambiguous versus terminal errors.
- `apps/web/src/app/api/admin/newsletter/draft/route.test.ts`: 3 tests covering frozen/sending edits and database race conflicts.
- `supabase/migrations/054_newsletter_claims.sql`: nullable additive columns, expanded ledger status constraint, immutable revision trigger, issue lease/heartbeat, recipient compare-and-set claim, guarded prepare/retry/finalize RPCs. RPC execute privileges are restricted to `service_role`; existing RLS and policies remain in place. Definitions/columns/trigger/constraint can be reapplied; no existing row data is rewritten.

## Recovery policy and SDK verification

Issue and recipient leases are 15 minutes, using database time. A crashed recipient is reclaimed with the stored exact payload and original provider key. Every completion checks both claim token and `sending` status. Replaced issue owners cannot claim new recipients or finalize/release the replacement owner's run.

The installed Resend SDK is **6.12.4**. Its `dist/index.d.mts` exposes `idempotencyKey` in request options, and `dist/index.mjs` sets the `Idempotency-Key` HTTP header. Adapter tests verify the option reaches `emails.send`.

The policy assumes an assumed **24-hour** key retention and allows automatic ambiguous recovery only within **23 hours** of the first attempt. Older ambiguous claims become `unknown`, remain incomplete, and are excluded from explicit failed-recipient retry. Reconcile them against provider delivery records before deciding whether to mark sent or authorize a new delivery; never simply reset them to pending.

## Migration application (not performed)

1. Use a disposable local/staging PostgreSQL/Supabase database containing the existing migrations through 052. Inspect existing `sending` issues and sent/failed recipients: historical sends lack claims and immutable snapshots, so resolve in-flight legacy deliveries before rollout. No automatic backfill is provided or needed for new drafts; historical ambiguity requires operator reconciliation.
2. Dry-run the SQL in a transaction ending with `ROLLBACK`, with stop-on-error enabled, and inspect column definitions, trigger, function ACLs, and unchanged RLS policies. Then apply 054 to that disposable database using the repository migration runner (or `psql -v ON_ERROR_STOP=1 -1 -f supabase/migrations/054_newsletter_claims.sql`). Reapply to verify idempotence.
3. In staging, race two SQL sessions against the same issue/recipient; verify only one claim is returned. Check lease boundaries, stale-token writes, edit-vs-send, prepare-vs-send, retry-vs-send, and unknown-delivery fencing. Use a mock provider only.
4. Production application requires separate explicit production approval. Apply the migration before deploying this application code. This change does not enable autosend.

## Validation

- Tests were added and run failing before the send-engine implementation.
- `pnpm test` in `apps/web`: **359 tests passed, 50 files passed** (26 new tests).
- `pnpm lint` in `apps/web`: **0 errors, 2 pre-existing warnings** (`MemberDirectory.tsx`, `stripeNet.test.ts`).
- `git diff --check`: passed.
- Shared package local artifacts were generated offline. Its standard build initially lacked Node typings; `pnpm --dir packages/shared exec tsc --types node --typeRoots ../../apps/web/node_modules/@types` succeeded without source/config changes.
- An additional web TypeScript check reports existing repository errors (test imports, BigInt target, asset declarations, etc.); no errors were reported in the modified newsletter/email implementation in that check. It is not a requested passing gate.

## Remaining gaps

- No local PostgreSQL server is installed, so the migration and true database concurrency/ACL behavior were not executed here. Vitest uses an atomic in-memory Supabase model. The staging checks above remain necessary.
- Provider retention documentation was not re-fetched because network use was prohibited beyond the explicitly requested GitHub reads. Reconfirm the 24-hour guarantee before production rollout; SDK support alone does not establish retention.
- Unknown delivery requires manual reconciliation; there is no new admin UI action to override it. Progress exposes `unknown` and `sending` counts, and failed retry excludes both.
- Legacy deliveries cannot retroactively acquire provider keys or reconstruct the exact historical revision; audit/reconcile any pre-existing in-flight issue before rollout.
- A cron request can still time out on a large audience. Claims make subsequent invocations/admin batches recoverable; scheduler cadence and runtime duration are unchanged.

## Fix pass

Independent NO-SHIP review: `/home/uni/.hermes/cache/scratch/review-97.md`, commit `4d4d300`, issue #97. Ported the three reviewer reproductions into `apps/web/src/lib/newsletterRecovery.test.ts` with safety assertions and ran them **before implementation: all three failed** (uncertainty erased, two deliveries after stale acknowledgement, opted-out recipient sent).

- **Finding 1 (P1):** first dispatch is stamped only by dispatch authorization. Recovery keeps `sending` (uncertain) across subsequent rejection, missing config, rate limit, quota, or exception; neither worker nor retry clears the original timestamp. A database trigger prohibits changing the original timestamp or exact payload/key after dispatch. Claim and dispatch quarantine expired attempts as terminal `needs_review`; neither automatic claim nor explicit failed retry can send those rows. Five adapted REPRO1 variants now retain the original timestamp/key and report **one delivery, needs_review** after 25 hours. Provider acceptance resolves uncertainty; a later rejection cannot resolve earlier acceptance.
- **Finding 2 (P1):** immediately before each provider invocation, `newsletter_dispatch_recipient` requires the current issue and recipient tokens, live 15-minute leases, and the original 23-hour recovery deadline; zero affected rows means zero provider calls. Authorization stamps `dispatched_at` and renews both leases. A dispatch acknowledgement taking 30 seconds or longer is discarded using monotonic elapsed time. The installed SDK's fetch path receives `AbortSignal.timeout(30_000)`, comfortably below the lease. Adapted REPRO2 reports **one delivery, one completion**, with **zero calls by the delayed original worker**. An expired claim without a replacement also makes zero calls. A real SDK test with mocked fetch verifies the abort signal and idempotency header without network I/O.
- **Finding 3 (P2):** claim and dispatch both exclude current `email_unsubscribes` records case-insensitively. Re-preparation cancels unattempted pending rows absent from the current audience; attempted uncertainty retains its provenance. Adapted REPRO3 reports **zero calls, skipped**. Another test opts out after preparation without re-preparing and also reports zero calls.

Migration renamed to **054_newsletter_claims.sql** to reserve 053 for #98. Migration contract tests check the rename, dispatch predicates, provenance guard, opt-out predicates, preparation cancellation, and service-role-only RPC grants. These are static contract checks and in-memory RPC reproductions, not execution on PostgreSQL; the local database verification gap above remains.

Retention citation: installed `apps/web/node_modules/resend/dist/index.d.mts`, `IdempotentRequest` (lines 177–184), documents the key but no duration; `dist/index.mjs` (`post`, lines 1127–1137) emits the header and forwards fetch options; `fetchRequest` (line 1071 onward) uses fetch. No local SDK README documents retention. **24 hours is an assumption explicitly requested by #97**, not a verified provider guarantee; automatic recovery stops at 23 hours from the original dispatch.

Validation: full `cd apps/web && pnpm test && pnpm lint`; adapted reviewer command re-run from its scratch root; `git diff --check origin/main..HEAD`. Results recorded below after final gates. Autosend gate/config remains unchanged and OFF by default. No network, real provider, production, secrets, environment-file edits, workspace-config edits, or push.

Final gates: **373 tests / 53 files passed**; lint **0 errors, 2 unchanged warnings** (`MemberDirectory.tsx`, `stripeNet.test.ts`). Adapted scratch reproductions: **10 passed**, covering all three original findings plus rejection/exception and delayed-dispatch variants; each original unsafe outcome no longer reproduces. Migration-focused tests after the rename and wall-clock lease checks: **51 passed / 3 files**. Lease predicates use `clock_timestamp()` so a lock wait cannot preserve stale transaction-start authorization. `git diff --check` and `git diff --check origin/main..HEAD` passed. No PostgreSQL execution was performed because no local server binaries are installed.
