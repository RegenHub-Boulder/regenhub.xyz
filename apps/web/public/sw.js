// RegenHub service worker — keeps the door code accessible when cell is bad.
//
// Strategy per route family:
//   /portal/my-code           network-first, fall back to cache (24h)
//   /portal/my-code (page)    same — keeps RSC + HTML usable offline
//   anything else             network-only (don't cache stale member data)
//
// We deliberately do NOT cache API routes or auth state. The door-code page
// is server-rendered with the current PIN baked into the HTML, so the cached
// HTML still shows the right code as long as the member's PIN hasn't changed
// since the last visit. If they rotate their code while offline, they'll
// need to come back online — but the keypad would have the new code already.

const CACHE_NAME = 'regenhub-doorcode-v1';
const DOOR_CODE_PATH = '/portal/my-code';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

self.addEventListener('install', (event) => {
  // Pre-cache the door-code page on install so it's available on first offline.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(DOOR_CODE_PATH).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Clean up older cache versions.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k.startsWith('regenhub-') && k !== CACHE_NAME).map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Only handle the door-code page itself + its RSC payload.
  const isDoorCode =
    url.pathname === DOOR_CODE_PATH ||
    url.pathname.startsWith(DOOR_CODE_PATH + '?') ||
    (url.searchParams.has('_rsc') && url.pathname === DOOR_CODE_PATH);
  if (!isDoorCode) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Network-first
      try {
        const fresh = await fetch(request);
        // Only cache successful, non-redirected responses.
        if (fresh.ok && fresh.status === 200) {
          const cloned = fresh.clone();
          const headers = new Headers(cloned.headers);
          headers.set('x-regenhub-cached-at', String(Date.now()));
          const body = await cloned.blob();
          await cache.put(request, new Response(body, { headers, status: cloned.status, statusText: cloned.statusText }));
        }
        return fresh;
      } catch {
        const cached = await cache.match(request);
        if (!cached) throw new Error('offline + uncached');
        const cachedAt = Number(cached.headers.get('x-regenhub-cached-at') ?? '0');
        if (cachedAt && Date.now() - cachedAt > MAX_AGE_MS) {
          // Older than 24h — still return it (better than nothing in front of
          // the keypad), but the page itself shows a stale-warning banner.
        }
        return cached;
      }
    })(),
  );
});
