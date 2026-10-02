// Dependency-free red proof: executes the original TypeScript sendBatch with
// a fluent Supabase double and a rendezvous inside the mocked provider.
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';
let source = execFileSync('git', ['show', '6cd7d14:apps/web/src/lib/newsletterSend.ts'], {encoding: 'utf8'});
source = source.replace(/^import .*?;\n/gm, '');
source = `const {compileAudience, renderDraftEmail, sendEmailDetailed, unsubscribeUrl} = globalThis.newsletterMocks;\n${source}`;
let calls = 0;
let release;
const both = new Promise(r => { release = r; });
globalThis.newsletterMocks = {
  compileAudience: async () => [],
  renderDraftEmail: () => ({html: 'frozen body', text: 'body'}),
  unsubscribeUrl: () => 'http://localhost/unsubscribe',
  sendEmailDetailed: async () => {
    calls++;
    if (calls === 2) release();
    await both;
    return {ok: true, id: `mock-${calls}`};
  },
};
const row = {id: 1, email: 'test@example.invalid', name: null, attempts: 0, status: 'pending'};
const admin = {from: () => {
  let writing = false;
  const q = new Proxy({}, {get: (_target, key) => {
    if (key === 'then') return (resolve) => resolve({data: writing ? [] : [{...row}]});
    return (...args) => { if (key === 'update') { writing = true; Object.assign(row, args[0]); } return q; };
  }});
  return q;
}};
const {sendBatch} = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
await Promise.all([sendBatch(admin, 1, {markdown:'body', subject:'s', siteUrl:'http://localhost'}), sendBatch(admin, 1, {markdown:'body', subject:'s', siteUrl:'http://localhost'})]);
console.log(`Actual overlapping old sendBatch provider calls: ${calls} (expected 1)`);
assert.equal(calls, 1, 'Overlapping workers must make exactly one provider call');
