/* eslint-disable @typescript-eslint/no-require-imports -- Next loads this runtime adapter as CommonJS. */
// Next 16.1.6 filesystem format adapter. Keep the version pinned and rerun the
// real runner smoke whenever Next changes: these imports are internal APIs.
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const FileSystemCache = require('next/dist/server/lib/incremental-cache/file-system-cache').default;
const { tagsManifest } = require('next/dist/server/lib/incremental-cache/tags-manifest.external');

module.exports = class IsolatedCache extends FileSystemCache {
  constructor(ctx) {
    super({ ...ctx, maxMemoryCacheSize: 0 });
    if (!process.env.ISR_CACHE_DIR) return; // Builds use Next's normal seed layout.
    const dir = process.env.ISR_CACHE_DIR;
    if (!path.isAbsolute(dir)) throw new Error('ISR_CACHE_DIR must be absolute');
    const buildDir = path.resolve(ctx.serverDistDir, '..');
    const relative = path.relative(buildDir, dir);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('ISR_CACHE_DIR must be outside the executable build');
    }
    const buildId = fs.readFileSync(path.join(buildDir, 'BUILD_ID'), 'utf8').trim();
    if (!/^[\w-]+$/.test(buildId)) throw new Error('Invalid BUILD_ID');
    this.storage = path.join(dir, buildId);
    this.seed = new FileSystemCache({ ...ctx, flushToDisk: false, maxMemoryCacheSize: 0 });
    this.tagFile = path.join(this.storage, 'tags.json');
    this.loadTags();
  }

  getFilePath(key, kind) {
    const original = super.getFilePath(key, kind);
    if (!this.storage) return original;
    const relative = path.relative(path.resolve(this.serverDistDir, '..'), original);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Cache key outside storage');
    return path.join(this.storage, relative);
  }

  loadTags() {
    try {
      const entries = JSON.parse(fs.readFileSync(this.tagFile, 'utf8'));
      for (const [tag, entry] of entries) tagsManifest.set(tag, entry);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async get(key, ctx) {
    if (!this.storage) return super.get(key, ctx);
    this.loadTags();
    const suffix = ctx.kind === 'FETCH' ? '' : ctx.kind === 'APP_ROUTE' ? '.body' : '.html';
    // Only fall back when no runtime entry exists, never when tag invalidation
    // rejected an existing entry. All seed reads have disk flushing disabled.
    if (!fs.existsSync(this.getFilePath(key + suffix, ctx.kind))) return this.seed.get(key, ctx);
    return super.get(key, ctx);
  }

  async revalidateTag(tags, durations) {
    if (!this.storage) return super.revalidateTag(tags, durations);
    // Single Node process per volume. No await between loading and capturing
    // the update; atomic rename prevents partial manifests across restarts.
    this.loadTags();
    const update = super.revalidateTag(tags, durations);
    fs.mkdirSync(this.storage, { recursive: true });
    const temp = this.tagFile + '.' + randomUUID();
    try {
      fs.writeFileSync(temp, JSON.stringify([...tagsManifest]));
      fs.renameSync(temp, this.tagFile);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    await update;
  }
};
