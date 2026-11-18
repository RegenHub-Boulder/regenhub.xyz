"""T-482 part 3 walkthrough: one door. "Sign in with Techne" signs you into the whole site (staging, sample data),
9:16, narrated. Uses the video lab's walkthrough template (~/Code/unforced-media/video-lab/tools, read-only).

    KOKORO_CACHE=~/.cache/t482-bvz3/kokoro ~/Code/unforced-media/video-lab/.venv/bin/python walkthrough/film-one-door.py capture
    KOKORO_CACHE=~/.cache/t482-bvz3/kokoro ~/Code/unforced-media/video-lab/.venv/bin/python walkthrough/film-one-door.py render
Env T482_BASE (default http://127.0.0.1:18610; the review fix used 18640). Each capture needs a fresh preview (it links Jo's account).
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAB = Path.home() / 'Code/unforced-media/video-lab'
sys.path.insert(0, str(LAB / 'tools'))
import kit  # noqa: E402
import walkfilm  # noqa: E402
from wordlock import Voice  # noqa: E402

OUT = Path.home() / '.cache/t482-bvz3/film'
CAP = OUT / 'cap'
BASE = os.environ.get('T482_BASE', 'http://127.0.0.1:18610')
W, H, FPS = 720, 1280, 24
go = lambda path: f"location.href = {path!r}"  # noqa: E731
DOOR = '[data-testid=techne-door] button:has-text("Sign in with Techne")'
MENU = "button[aria-label='Open menu']"
OUTB = "[aria-label='Navigation menu'] button:has-text('Sign out')"
TO_LINK = ("location.href = (u => u.pathname + u.search)"
           "(new URL(document.querySelector('a[href*=\"/auth/techne/link\"]').href))")
STEPS = [
    {'id': 'door', 'mark': DOOR, 'after': 300},
    {'id': 'signin', 'tap': DOOR, 'after': 2500},
    {'id': 'ana', 'tap': 'a:has-text("Ana (sample)")', 'after': 5000},
    {'id': 'portal', 'mark': 'h1', 'after': 300},
    {'id': 'menu', 'tap': MENU, 'after': 800, 'quiet': True},
    {'id': 'out', 'tap': OUTB, 'after': 3500},
    {'id': 'night', 'js': go('/events/agents-night'), 'wait': 2500, 'tap': 'a:has-text("Details and RSVP")', 'after': 3000},
    {'id': 'rsvpdoor', 'scroll': '[data-testid=rsvp-panel]', 'tap': '[data-testid=rsvp-panel] button:has-text("Sign in with Techne")', 'after': 2500},
    {'id': 'jo', 'tap': 'a:has-text("Jo (sample)")', 'after': 5000},
    {'id': 'going', 'scroll': '[data-testid=rsvp-panel]', 'mark': '[data-testid=rsvp-panel]', 'after': 300},
    {'id': 'notlinked', 'js': go('/portal'), 'wait': 5000, 'mark': '[data-testid=techne-not-linked]', 'after': 300},
    {'id': 'email', 'fill': ("input[aria-label='Membership email']", 'jo-sample@example.test'), 'after': 300},
    {'id': 'send', 'tap': 'button:has-text("Email me a link")', 'after': 2500},
    {'id': 'inbox', 'js': go('/staging/outbox'), 'wait': 1500, 'mark': 'a:has-text("Link my Techne account")', 'after': 300},
    {'id': 'linkpage', 'js': TO_LINK, 'wait': 3500, 'mark': 'button:has-text("Link and open my portal")', 'after': 300},
    {'id': 'linked', 'tap': 'button:has-text("Link and open my portal")', 'after': 5000},
    {'id': 'toprofile', 'js': go('/portal/profile'), 'wait': 3500, 'mark': 'h1', 'after': 300, 'quiet': True},
    {'id': 'profile', 'scroll': '[data-testid=techne-account]', 'mark': '[data-testid=techne-account]', 'after': 300},
    {'id': 'notice', 'js': go('/staging/outbox'), 'wait': 1500, 'mark': 'text=A Techne account was linked', 'after': 300},
    {'id': 'back', 'js': go('/portal'), 'wait': 3500, 'mark': 'h1', 'after': 300, 'quiet': True},
    {'id': 'menu2', 'tap': MENU, 'after': 800, 'quiet': True},
    {'id': 'out2', 'tap': OUTB, 'after': 3500, 'quiet': True},
    {'id': 'again', 'tap': DOOR, 'after': 2500, 'quiet': True},
    {'id': 'jo2', 'tap': 'a:has-text("Jo (sample)")', 'after': 5000},
    {'id': 'joportal', 'mark': 'h1', 'after': 300},
]
V = Voice([
    ('door', 'This is regenhub dot x y z on staging, with sample people. [door]Every sign-in is now one button: Sign in with Techne. The email link is still there, folded underneath.', {'gap': .5}),
    ('signin', '[signin]A stand-in plays Techne\'s sign-in screen.', {'gap': .2}),
    ('ana', '[ana]Ana\'s Techne account is linked to her membership,', {'gap': .1}),
    ('portal', 'so [portal]one sign-in opens her portal. No second login.', {'gap': .5}),
    ('out', '[out]Sign out ends both, on the server. Nothing left in the browser signs back in.', {'gap': .5}),
    ('rsvpdoor', 'Jo is a member whose account isn\'t linked yet. [rsvpdoor]She signs in on an event,', {'gap': .1}),
    ('jo', '[jo]and Techne alone', {'gap': .1}),
    ('going', 'is [going]enough to R S V P.', {'gap': .5}),
    ('notlinked', 'When she opens the portal, [notlinked]it asks once.', {'gap': .2}),
    ('email', '[email]The email on her membership.', {'gap': .1}),
    ('send', '[send]The link goes to that address, never to one Techne claims.', {'gap': .5}),
    ('inbox', '[inbox]She opens it on the same device,', {'gap': .1}),
    ('linkpage', '[linkpage]confirms it\'s her account,', {'gap': .1}),
    ('linked', 'and [linked]she\'s in.', {'gap': .4}),
    ('profile', '[profile]Her profile shows the linked account, with Unlink,', {'gap': .1}),
    ('notice', 'and [notice]she gets an email saying it was linked.', {'gap': .5}),
    ('jo2', 'Next time, [jo2]one tap', {'gap': .1}),
    ('joportal', '[joportal]opens the portal.', {'gap': .8}),
], OUT / 'vo')
DUR = V.duration + .8


def shots():
    ids = [s['id'] for s in STEPS if s['id'] in V.lines]
    cues = {i: V.at(i) for i in ids}
    rows = []
    for k, i in enumerate(ids):
        nxt = cues[ids[k + 1]] - .8 if k + 1 < len(ids) else DUR
        rows.append((i, cues[i], min(V.lines[i]['end'] + .5, nxt)))
    return rows


if __name__ == '__main__':
    if sys.argv[1] == 'capture':
        from playwright.sync_api._generated import BrowserType
        _launch = BrowserType.launch
        BrowserType.launch = lambda self, **kw: _launch(self, **{k: v for k, v in kw.items() if k != 'executable_path'})
        walkfilm.capture(BASE + '/portal', STEPS, CAP)
    else:
        F = walkfilm.Film(CAP, shots(), W=W, H=H)
        bed = Path.home() / '.local/share/uni/media-studio/beds/corner_say_bed.wav'
        wav = kit.write_wav(OUT / 'mix.wav', kit.mix_voice_bed(V.placed, DUR, bed))
        kit.render(F.frame, DUR, HERE / 't482-one-door.mp4', W, H, FPS, wav, workers=6, crf=23)
        print('duration', DUR)
