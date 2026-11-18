"""T-482 part 2 walkthrough: one "Sign in with Techne" door for stewards and RSVP (staging, sample data), 9:16, narrated.
Uses the video lab's walkthrough template (~/Code/unforced-media/video-lab/tools, read-only).

    .venv/bin/python walkthrough/film-door.py capture   # steps through the preview for real (fresh RSVP state)
    .venv/bin/python walkthrough/film-door.py render    # -> walkthrough/t482-techne-door.mp4
Env T482_BASE (default http://127.0.0.1:18600). Each capture needs a fresh preview (it posts Civic Tech Night).
Superseded by film-one-door.py (T-482 part 3): /staging/portal-session is gone, so this capture no longer runs as is.
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

OUT = Path.home() / '.cache/t482-6c63/film'
CAP = OUT / 'cap'
BASE = os.environ.get('T482_BASE', 'http://127.0.0.1:18600')
W, H, FPS = 720, 1280, 24
go = lambda path: f"location.href = {path!r}"  # noqa: E731
SIGN_IN = '[data-testid=steward-panel] button:has-text("Sign in with Techne")'
STEPS = [
    {'id': 'portal', 'mark': SIGN_IN, 'after': 300},
    {'id': 'signin', 'tap': SIGN_IN, 'after': 2500},
    {'id': 'pick', 'tap': 'a:has-text("RegenHub steward (sample)")', 'after': 4000},
    {'id': 'steward', 'mark': '[data-testid=steward-who]', 'after': 300},
    {'id': 'tick', 'scroll': '[data-testid=add-series-nights]', 'tap': "[data-testid=add-series-nights] fieldset:has-text('Civic Tech Night') input[type=checkbox]", 'after': 500},
    {'id': 'post', 'tap': "button:has-text('Post 1 night')", 'after': 5000},
    {'id': 'posted', 'scroll': "h3:has-text('Civic Tech Night')", 'mark': "h3:has-text('Civic Tech Night')", 'after': 300},
    {'id': 'night', 'js': go('/events/civic-tech-night'), 'wait': 2500, 'tap': 'a:has-text("Details and RSVP")', 'after': 3500},
    {'id': 'same', 'scroll': '[data-testid=rsvp-panel]', 'mark': 'button:has-text("I\'m going")', 'after': 300},
    {'id': 'going', 'tap': 'button:has-text("I\'m going")', 'after': 3000},
    {'id': 'out', 'tap': 'button:has-text("Sign out of Techne")', 'after': 1500},
    {'id': 'member', 'js': go('/portal/events'), 'wait': 3000, 'tap': SIGN_IN, 'after': 2500, 'quiet': True},
    {'id': 'lee', 'tap': 'a:has-text("Lee (sample)")', 'after': 4000},
    {'id': 'form', 'mark': '[data-testid=steward-hint]', 'after': 300},
    {'id': 'new', 'tap': "button:has-text('New event')", 'after': 800, 'quiet': True},
    {'id': 'name', 'fill': ('#ev-name', "Lee's night"), 'after': 300, 'quiet': True},
    {'id': 'when', 'fill': ('#ev-starts', '2026-12-20T18:30'), 'after': 300, 'quiet': True},
    {'id': 'try', 'tap': "button:has-text('Create event')", 'after': 3000},
    {'id': 'nope', 'js': 'window.scrollTo(0, 0)', 'wait': 500, 'mark': "p:has-text(\"Techne didn't accept a post as RegenHub\")", 'after': 300},
]
V = Voice([
    ('portal', 'This is regenhub dot x y z on staging, with sample data. [portal]Manage Events asks for one thing: Sign in with Techne.', {'gap': .6}),
    ('signin', 'A stand-in [signin]plays the sign-in screen.', {'gap': .3}),
    ('pick', '[pick]The steward signs in.', {'gap': .6}),
    ('steward', 'RegenHub\'s own record on Techne says [steward]they manage RegenHub. No email from scenius, no hop to beacon.', {'gap': .6}),
    ('tick', 'Civic Tech Night is confirmed but not posted. [tick]Tick it,', {'gap': .2}),
    ('post', '[post]and post it.', {'gap': .5}),
    ('posted', 'It is now [posted]RegenHub\'s own event on Techne, written as the collective.', {'gap': .7}),
    ('night', 'The [night]same person opens the night,', {'gap': .3}),
    ('same', 'and is [same]already signed in. One Techne session for the whole site.', {'gap': .4}),
    ('going', '[going]I am going writes their own R S V P.', {'gap': .7}),
    ('out', '[out]Sign out.', {'gap': .3}),
    ('lee', 'Someone who doesn\'t manage RegenHub [lee]signs in.', {'gap': .4}),
    ('form', 'Everyone gets [form]the same form. The page only says what to expect.', {'gap': .4}),
    ('try', 'They [try]try to post,', {'gap': .3}),
    ('nope', '[nope]and Techne says no, in its own words.', {'gap': .9}),
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
        walkfilm.capture(BASE + '/staging/portal-session', STEPS, CAP)
    else:
        F = walkfilm.Film(CAP, shots(), W=W, H=H)
        bed = Path.home() / '.local/share/uni/media-studio/beds/corner_say_bed.wav'
        wav = kit.write_wav(OUT / 'mix.wav', kit.mix_voice_bed(V.placed, DUR, bed))
        kit.render(F.frame, DUR, HERE / 't482-techne-door.mp4', W, H, FPS, wav, workers=6, crf=23)
        print('duration', DUR)
