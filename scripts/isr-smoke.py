#!/usr/bin/env python3
"""Local-only actual Docker runner smoke. Requires sudo -n docker, no services.
Fixture routes exist only in a temporary build context, never in the app tree.
Use --baseline to disable storage redirection and demonstrate the ISR failure.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DOCKER = ['sudo', '-n', 'docker']


def docker(*args, capture=False):
    return subprocess.check_output(DOCKER + list(args), text=True).strip() if capture else subprocess.check_call(DOCKER + list(args))


def stage(dest):
    shutil.copytree(ROOT, dest, ignore=shutil.ignore_patterns('.git', 'node_modules', '.next', 'dist', '.env.local', '.env', '*.tsbuildinfo'))
    app = dest / 'apps/web/src/app'
    fixtures = {
        'isr-smoke-page/[slug]/page.tsx': '''import { randomUUID } from "node:crypto";
export const revalidate = 3600;
export function generateStaticParams() { return [{ slug: 'seed' }]; }
export default function Page() { return <main>ISR_PAGE_{randomUUID()}</main>; }
''',
        'isr-smoke-route/[slug]/route.ts': '''import { randomUUID } from "node:crypto";
export const revalidate = 3600;
export const dynamic = "force-static";
export function generateStaticParams() { return [{ slug: 'seed' }]; }
export function GET() { return new Response('ISR_ROUTE_' + randomUUID()); }
''',
        'isr-smoke-invalidate/route.ts': '''import { revalidatePath } from "next/cache";
export function POST() {
  revalidatePath('/isr-smoke-page/seed'); revalidatePath('/isr-smoke-route/seed');
  return new Response('ok');
}
''',
    }
    for filename, content in fixtures.items():
        target = app / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)


PROBE = r'''
const fs = require('fs'); const path = require('path'); const assert = require('assert');
assert.equal(process.getuid(), 1001);
function walk(dir) { return fs.readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : e.isFile() ? [path.join(dir,e.name)] : []); }
const server = '/app/apps/web/apps/web/.next/server';
const files = [...walk(server).filter(p=>p.endsWith('.js')), '/app/apps/web/apps/web/server.js', '/app/apps/web/apps/web/cache-handler.cjs'];
assert(files.length > 0);
for (const file of files) {
 assert.equal(fs.statSync(file).uid, 0);
 for (let dir=path.dirname(file); dir !== '/'; dir=path.dirname(dir)) {
  const st=fs.statSync(dir); assert.equal(st.uid,0); assert.equal(st.mode & 0o022,0,dir);
 }
 for (const op of [()=>fs.writeFileSync(file,'BAD'), ()=>fs.unlinkSync(file), ()=>fs.renameSync(file,file+'.probe')]) {
  assert.throws(op, e=>['EACCES','EPERM','EROFS'].includes(e.code),file);
 }
}
for (const dir of ['/app/apps/web/apps/web/.next/static','/app/apps/web/apps/web/public','/app/apps/web/supabase/migrations']) {
 for (const file of walk(dir)) {
  const st=fs.statSync(file); assert.equal(st.uid,0); assert.equal(st.mode & 0o022,0,file);
  assert.throws(()=>fs.writeFileSync(file,'BAD'), e=>['EACCES','EPERM','EROFS'].includes(e.code));
  assert.throws(()=>fs.unlinkSync(file), e=>['EACCES','EPERM','EROFS'].includes(e.code));
  assert.throws(()=>fs.renameSync(file,file+'.probe'), e=>['EACCES','EPERM','EROFS'].includes(e.code));
 }
}
console.log('UID1001: overwrite/unlink/rename blocked for '+files.length+' server JS files; static/public/migrations immutable');
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', default='regenhub-isr-smoke:local')
    parser.add_argument('--skip-build', action='store_true')
    parser.add_argument('--baseline', action='store_true')
    args = parser.parse_args()
    if not args.skip_build:
        with tempfile.TemporaryDirectory(prefix='rh100-build-') as temp:
            context = Path(temp) / 'context'
            stage(context)
            docker('build', '--progress=plain', '-f', str(context / 'apps/web/Dockerfile'), '-t', args.image,
                   '--build-arg', 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321',
                   '--build-arg', 'NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-local-anon-key',
                   '--build-arg', 'NEXT_PUBLIC_SITE_URL=http://localhost:3000',
                   '--build-arg', 'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=synthetic-local-project', str(context))
    volume = docker('volume', 'create', capture=True)
    container = None
    try:
        container = docker('run', '-d', '-p', '127.0.0.1::3000', '--mount', f'type=volume,src={volume},dst=/var/cache/regenhub-isr',
                           '-e', 'SUPABASE_SERVICE_ROLE_KEY=synthetic-local-service-key',
                           '-e', 'ISR_CACHE_DIR=' + ('' if args.baseline else '/var/cache/regenhub-isr'), args.image, capture=True)
        def container_origin():
            port = json.loads(docker('inspect', container, capture=True))[0]['NetworkSettings']['Ports']['3000/tcp'][0]['HostPort']
            return f'http://127.0.0.1:{port}'

        origin = container_origin()

        def request(route, method='GET'):
            with urllib.request.urlopen(urllib.request.Request(origin + route, method=method), timeout=10) as response:
                return response.read().decode(), response.headers.get('x-nextjs-cache')

        def ready():
            for _ in range(60):
                try:
                    request('/isr-smoke-route/seed')
                    return
                except Exception:
                    time.sleep(1)
            raise RuntimeError('runner not ready')

        ready()
        docker('exec', container, 'node', '-e', PROBE)
        routes = ['/isr-smoke-page/seed', '/isr-smoke-route/seed']
        first = [request(route)[0] for route in routes]
        assert 'ISR_PAGE_' in first[0] and 'ISR_ROUTE_' in first[1]
        print('Loaded prerendered APP_PAGE and APP_ROUTE seed markers', flush=True)
        time.sleep(0.02)
        request('/isr-smoke-invalidate', 'POST')
        second = [request(route)[0] for route in routes]
        assert all(a != b for a, b in zip(first, second)), 'both routes must actually regenerate'
        print('revalidatePath changed both APP_PAGE and APP_ROUTE render markers', flush=True)
        files = docker('exec', container, 'find', '/var/cache/regenhub-isr', '-type', 'f', capture=True)
        print('Runtime data files:\n' + files, flush=True)
        assert '/isr-smoke-page/seed.html' in files and '/isr-smoke-route/seed.body' in files, 'ISR data was not persisted outside executable build'
        docker('restart', container)
        origin = container_origin()
        ready()
        restored = [request(route) for route in routes]
        assert [body for body, _ in restored] == second, 'restart lost regenerated data'
        assert all(status == 'HIT' for _, status in restored), restored
        print('PASS: real APP_PAGE + APP_ROUTE regenerated, persisted and HIT after restart', flush=True)
        time.sleep(0.02)
        request('/isr-smoke-invalidate', 'POST')
        docker('restart', container)
        origin = container_origin()
        ready()
        after_invalidation = [request(route)[0] for route in routes]
        assert all(a != b for a, b in zip(second, after_invalidation)), 'restart lost tag invalidation'
        print('PASS: tag invalidations persisted across restart and both routes regenerated again', flush=True)
        logs = docker('logs', container, capture=True)
        assert 'EACCES' not in logs and 'Failed to update' not in logs, logs
    finally:
        if container:
            docker('logs', container)
            docker('rm', '-f', container)
        docker('volume', 'rm', volume)


if __name__ == '__main__':
    main()
