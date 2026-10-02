const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const nextFs = require('../apps/web/node_modules/next/dist/server/lib/node-fs-methods').nodeFs;
const Handler = process.env.ISR_BASELINE === '1'
  ? require('../apps/web/node_modules/next/dist/server/lib/incremental-cache/file-system-cache').default
  : require('../apps/web/cache-handler.cjs');

test('APP_PAGE, APP_ROUTE and FETCH writes stay outside the build and survive a new handler', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-isr-'));
  try {
    const build = path.join(temp, '.next/server');
    await fs.mkdir(build, { recursive: true });
    await fs.writeFile(path.join(build, '../BUILD_ID'), 'test-build');
    process.env.ISR_CACHE_DIR = path.join(temp, 'data');
    const options = { fs: nextFs, serverDistDir: build, flushToDisk: true, maxMemoryCacheSize: 0, revalidatedTags: [] };
    const cache = new Handler(options);
    const page = { kind: 'APP_PAGE', html: 'page', rscData: Buffer.from('flight'), headers: { 'x-next-cache-tags': 'page-tag' }, status: 200, segmentData: new Map([['/part', Buffer.from('segment')]]) };
    const route = { kind: 'APP_ROUTE', body: Buffer.from('route'), headers: {}, status: 201 };
    for (const [key, value] of [['/page', page], ['/route', route], ['fetch-key', { kind: 'FETCH', data: { body: 'fetch', headers: {}, status: 200, url: 'http://localhost' }, revalidate: 5 }]]) {
      await cache.set(key, value, { fetchCache: value.kind === 'FETCH', tags: ['fetch-tag'] });
      const restored = await new Handler(options).get(key, { kind: value.kind, tags: ['fetch-tag'] });
      assert.equal(restored.value.kind, value.kind);
      if (value.body) assert.deepEqual(restored.value.body, value.body);
      if (value.segmentData) assert.deepEqual(restored.value.segmentData, value.segmentData);
    }
    assert.deepEqual(await fs.readdir(build), []);
    await cache.revalidateTag('page-tag');
    require('../apps/web/node_modules/next/dist/server/lib/incremental-cache/tags-manifest.external').tagsManifest.clear();
    assert.equal(await new Handler(options).get('/page', { kind: 'APP_PAGE' }), null);
    await assert.rejects(cache.set('../../../../escape', route, {}), /outside/);
    await cache.revalidateTag('fetch-tag', { expire: 60 });
    assert.ok(await cache.get('fetch-key', { kind: 'FETCH', tags: ['fetch-tag'] }));
    const now = Date.now;
    try {
      Date.now = () => now() + 61000;
      assert.equal(await new Handler(options).get('fetch-key', { kind: 'FETCH', tags: ['fetch-tag'] }), null);
    } finally { Date.now = now; }
    await fs.writeFile(path.join(build, '../BUILD_ID'), 'different-build');
    assert.equal(await new Handler(options).get('/route', { kind: 'APP_ROUTE' }), null);

  } finally {
    delete process.env.ISR_CACHE_DIR;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('immutable prerender seed is readable but never written', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-seed-'));
  try {
    const build = path.join(temp, '.next/server');
    await fs.mkdir(path.join(build, 'app'), { recursive: true });
    await fs.writeFile(path.join(build, '../BUILD_ID'), 'seed-build');
    await fs.writeFile(path.join(build, 'app/seed.body'), 'seed');
    await fs.writeFile(path.join(build, 'app/seed.meta'), '{"status":200,"headers":{}}');
    process.env.ISR_CACHE_DIR = path.join(temp, 'data');
    const cache = new Handler({ fs: nextFs, serverDistDir: build, flushToDisk: true, maxMemoryCacheSize: 0, revalidatedTags: [] });
    assert.equal((await cache.get('/seed', { kind: 'APP_ROUTE' })).value.body.toString(), 'seed');
    await cache.set('/seed', { kind: 'APP_ROUTE', body: Buffer.from('updated'), headers: {}, status: 200 }, {});
    assert.equal((await cache.get('/seed', { kind: 'APP_ROUTE' })).value.body.toString(), 'updated');
    assert.equal(await fs.readFile(path.join(build, 'app/seed.body'), 'utf8'), 'seed');
  } finally {
    delete process.env.ISR_CACHE_DIR;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
