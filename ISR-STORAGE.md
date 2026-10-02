# ISR storage and local verification

The web app uses Next **16.1.6**, with App Router incremental caching and without
Cache Components. `cacheHandler` (singular) handles FETCH, APP_PAGE, APP_ROUTE and
PAGES; `cacheHandlers` is a different API for `use cache` and is not appropriate
here. `cacheMaxMemorySize: 0` avoids a process-local LRU hiding persistence failures.

The adapter in `apps/web/cache-handler.cjs` reuses the pinned Next filesystem
handler's HTML/RSC/segment, body/metadata, FETCH serialization and tag expiration
semantics. It redirects runtime writes to
`$ISR_CACHE_DIR/<BUILD_ID>/{server/app,server/pages,cache/fetch-cache}`. The build
remains a read-only seed source. A missing runtime entry falls back to its seed;
an entry rejected by tag invalidation never falls back to an old seed. Next's
seed FETCH reader disables reads when disk flushing is disabled, so FETCH starts
cold rather than modifying the immutable build. The adapter persists the tag
manifest with atomic rename, including delayed expiration semantics.

This deliberately uses internal Next modules for format compatibility. Keep Next
pinned; review installed `dist/server/lib/incremental-cache/{index,file-system-cache,tags-manifest.external}.js`
and rerun the unit and built-runner smoke on every upgrade. The interface and
configuration were checked against the version-matched primary documentation:

- [Next 16.1.6 cacheHandler documentation](https://github.com/vercel/next.js/blob/v16.1.6/docs/01-app/03-api-reference/05-config/01-next-config-js/incrementalCacheHandlerPath.mdx)
- [Next self-hosting caching guidance](https://nextjs.org/docs/app/guides/self-hosting#caching-and-isr)

## Deployment requirements (deployment is NOT authorized)

This runtime/storage change requires an explicit deployment go before changing
Coolify or any production container. No deployment or migration accompanies this
commit.

- The image sets `ISR_CACHE_DIR=/var/cache/regenhub-isr`. Mount a dedicated volume
  there for persistence across container replacement. A new Docker named volume
  inherits the image directory's UID/GID **1001:1001**; preexisting volumes or bind
  mounts must already give UID1001 write access. Never mount over `.next/server`,
  `.next/static`, `public`, migration directories, or their parents.
- Run **one Node process / one replica per volume**. The tag manifest is not a
  distributed lock or multi-process store. Scaling requires a shared cache
  backend with coordinated invalidation and an explicit design review.
- All build code, static files and SQL migrations stay root-owned. Only the ISR
  data directory and `.next/cache` (Next image optimizer data) are writable by
  UID1001. Neither writable directory is a parent of executable JS. Do not
  recursively chown the standalone tree, `.next`, or `.next/server`.
- Restarting the same build with the same volume preserves regenerated entries
  and tag invalidations. Next resets learned TTLs for newly generated dynamic
  paths absent from the prerender manifest to its native one-second default, so
  those entries can be served STALE and refreshed after restart. Seeded routes
  retain their manifest TTL. A new BUILD_ID starts a new namespace; old RSC and route
  data must not be reused across builds. Old namespaces can be removed while
  offline; cache data is disposable, so an empty volume simply regenerates.
- Data files use Next's own multi-file writer, with its existing consistency
  behavior. An interrupted write may produce a cache miss and regeneration.
  This is cache storage, not an authoritative database or a migration ledger.

## Reproduce locally

From the repo root with dependencies installed and Docker available:

```sh
node --test scripts/isr-cache.test.cjs
ISR_BASELINE=1 node --test scripts/isr-cache.test.cjs # expected failure: original Next writes into build
python3 scripts/isr-smoke.py
python3 scripts/isr-smoke.py --skip-build --baseline # expected failure: EACCES / no persisted ISR output
```

The smoke requires `sudo -n docker`. It builds the actual Dockerfile runner from a
temporary context containing the app plus two synthetic ISR fixture routes and
an invalidation route. Fixtures are never added to the deployed app source. Public
Supabase/site/WalletConnect build values are overridden at the command line with
localhost/synthetic values; runtime has a synthetic service key. No bot or live
integration is started. Test HTTP binds only to loopback on a Docker-assigned port.

The fixtures use a unique marker on each render, one-hour TTL, and an empty runtime
cache. Both seeded APP_PAGE and APP_ROUTE must change after `revalidatePath`,
write HTML/RSC and body/metadata outside the server tree, then return byte-identical
responses with `x-nextjs-cache: HIT` after a real container restart. The harness
also checks immutable build seeds, asserts UID1001, and attempts overwrite, unlink
and rename on every actual server JS file and every static/public/migration file.
Containers and the temporary data volume are removed in `finally`; the test image
is retained for repeating red/green smoke without rebuilding.
