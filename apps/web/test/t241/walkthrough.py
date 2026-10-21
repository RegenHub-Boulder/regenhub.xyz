"""Run with a Python environment containing Playwright. Uses only synthetic PGlite data.
Creates temporary Next routes, starts an isolated local dev process, records, and cleans up.
Narration is generated separately with studio's local Kokoro environment.
"""
import os, pathlib, shutil, subprocess, time, urllib.request
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parents[4]
WEB = ROOT / 'apps/web'
SCRATCH = pathlib.Path(os.environ.get('TMPDIR', '/tmp')) / 't241'
SCRATCH.mkdir(parents=True, exist_ok=True)
PAGE = WEB / 'src/app/t241-walk'
API = WEB / 'src/app/api/t241-fixture'
assert not PAGE.exists() and not API.exists()
PAGE.mkdir(); API.mkdir()
shutil.copyfile(pathlib.Path(__file__).with_name('fixture-page.tsx'), PAGE / 'page.tsx')
shutil.copyfile(pathlib.Path(__file__).with_name('fixture-route.ts'), API / 'route.ts')
env = {k: os.environ[k] for k in ['PATH', 'HOME', 'TMPDIR'] if k in os.environ}
env.update(T241_WALKTHROUGH='1', NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:3499', NEXT_PUBLIC_SUPABASE_ANON_KEY='t241-test', SUPABASE_SERVICE_ROLE_KEY='t241-test', NEXT_PUBLIC_SITE_URL='http://127.0.0.1:3401', NEXT_TELEMETRY_DISABLED='1')
log = open(SCRATCH / 'dev.log', 'w')
process = subprocess.Popen(['pnpm', '--filter', 'web', 'dev', '--hostname', '127.0.0.1', '--port', '3401'], cwd=ROOT, env=env, stdout=log, stderr=log, start_new_session=True)
try:
    for _ in range(180):
        if process.poll() is not None: raise RuntimeError('dev server stopped; inspect dev.log')
        try:
            if urllib.request.urlopen('http://127.0.0.1:3401/t241-walk', timeout=1).status == 200: break
        except Exception: time.sleep(0.5)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(pathlib.Path.home() / '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'))
        context = browser.new_context(viewport={'width':1280,'height':800}, record_video_dir=str(SCRATCH / 'video'), record_video_size={'width':1280,'height':800})
        def route_request(route):
            if not route.request.url.startswith('http://127.0.0.1:3401/'):
                route.abort(); return
            if '/api/admin/members/7/onchain-subscription' in route.request.url:
                response = route.fetch(url='http://127.0.0.1:3401/api/t241-fixture')
                route.fulfill(response=response); return
            route.continue_()
        context.route('**/*', route_request)
        page = context.new_page()
        page.goto('http://127.0.0.1:3401/t241-walk')
        page.get_by_role('button', name='Issue next test invoice').click()
        page.get_by_text('$500.00', exact=True).wait_for()
        page.wait_for_timeout(1500)
        # Begin the actual film after first-load compilation and DB startup.
        page.evaluate("document.querySelector('nextjs-portal')?.remove()")
        start = time.time()
        page.get_by_label('Plan for next invoice').select_option('member_2day')
        page.wait_for_timeout(2500)
        page.get_by_role('button', name='Save changes').click()
        page.get_by_role('status').wait_for()
        page.get_by_role('button', name='Issue next test invoice').click()
        page.get_by_text('$50.00', exact=True).wait_for()
        page.wait_for_timeout(max(0, 19000 - int((time.time()-start)*1000)))
        page.get_by_label('Plan for next invoice').select_option('')
        page.get_by_label('Subscription discount code').fill('SAVE20')
        page.wait_for_timeout(2500)
        page.get_by_role('button', name='Save changes').click()
        page.wait_for_timeout(600)
        page.get_by_role('button', name='Issue next test invoice').click()
        page.get_by_text('$40.00', exact=True).wait_for()
        page.wait_for_timeout(max(0, 48000 - int((time.time()-start)*1000)))
        video = page.video
        context.close()
        shutil.copyfile(video.path(), SCRATCH / 'walkthrough.webm')
        browser.close()
        print('Recorded', SCRATCH / 'walkthrough.webm')
finally:
    # Kill only the process group created above; never shared processes.
    import signal
    os.killpg(process.pid, signal.SIGTERM)
    process.wait(timeout=15)
    log.close()
    shutil.rmtree(PAGE); shutil.rmtree(API)
    shutil.rmtree(WEB / ".next/dev", ignore_errors=True)
