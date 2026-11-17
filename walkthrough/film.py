"""T-482 walkthrough: regenhub.xyz events on the staging preview (sample data), 16:9, narrated.
Uses the video lab's walkthrough template (~/Code/unforced-media/video-lab/tools, read-only).

    .venv/bin/python walkthrough/film.py capture   # steps through http://127.0.0.1:18590 for real (fresh staging state)
    .venv/bin/python walkthrough/film.py render    # -> walkthrough/t482-walkthrough.mp4
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAB = Path.home() / 'Code/unforced-media/video-lab'
sys.path.insert(0, str(LAB / 'tools'))
import kit  # noqa: E402
import walkfilm  # noqa: E402
from wordlock import Voice  # noqa: E402

OUT = Path.home() / '.cache/t482/film'
CAP = OUT / 'cap'
BASE = 'http://127.0.0.1:18590'
W, H, FPS = 1920, 1080, 24
go = lambda path: f"location.href = {path!r}"  # noqa: E731
STEPS = [
    {'id': 'home', 'scroll': 'section[aria-label="Regular nights"]', 'mark': 'section[aria-label="Regular nights"] h2', 'quiet': True, 'after': 300},
    {'id': 'events', 'js': go('/events'), 'wait': 2500, 'mark': '[data-testid=series-card-agents-night]', 'after': 300},
    {'id': 'series', 'js': go('/events/agents-night'), 'wait': 2500, 'mark': '[data-testid=series-next]', 'quiet': True, 'after': 300},
    {'id': 'later', 'mark': 'h2:has-text("After that")', 'quiet': True, 'after': 200},
    {'id': 'feed', 'mark': 'a[href="/events/agents-night.ics"]', 'after': 200},
    {'id': 'civic', 'js': go('/events/civic-tech-night'), 'wait': 2500, 'mark': '[data-testid=series-next]', 'quiet': True, 'after': 300},
    {'id': 'back', 'js': go('/events/agents-night'), 'wait': 2500, 'mark': 'a:has-text("Details and RSVP")', 'after': 200},
    {'id': 'night', 'tap': 'a:has-text("Details and RSVP")', 'after': 3000},
    {'id': 'signin', 'scroll': '[data-testid=rsvp-panel]', 'tap': '[data-testid=rsvp-panel] button:has-text("Sign in with Techne")', 'after': 2500},
    {'id': 'pick', 'tap': 'a:has-text("Lee (sample)")', 'after': 4000},
    {'id': 'going', 'scroll': '[data-testid=rsvp-panel]', 'tap': 'button:has-text("I\'m going")', 'after': 3000},
    {'id': 'record', 'mark': 'code', 'after': 200},
]
V = Voice([
    ('home', 'This is regenhub dot x y z on staging, with sample data. The home page now [home]leads with the two regular nights.', {'gap': .9}),
    ('events', 'On the [events]events page, Agents Night and Civic Tech Night come first, each with its next date.', {'gap': .9}),
    ('series', 'Each series has its own [series]page: what the night is, and when it is next.', {'gap': .4}),
    ('later', 'The [later]nights after that are planned, and marked to be confirmed.', {'gap': .5}),
    ('feed', 'One link [feed]adds the series to your calendar, and keeps it up to date.', {'gap': .9}),
    ('civic', '[civic]Civic Tech Night works the same way, on the second Thursday of each month.', {'gap': .8}),
    ('back', 'Back on Agents Night, the [back]first night is already posted, as a real Techne event.', {'gap': .5}),
    ('night', '[night]Open it to R S V P.', {'gap': .8}),
    ('signin', 'R S V P starts with [signin]Sign in with Techne, the way the Techne docs describe it.', {'gap': .5}),
    ('pick', 'On staging, a stand-in plays the sign-in screen. [pick]Lee, a sample person, signs in.', {'gap': .9}),
    ('going', '[going]I am going. That writes Lee\'s own R S V P record, and the count goes up.', {'gap': .9}),
    ('record', 'And the [record]event itself is a public Techne record. Nothing here touched production.', {'gap': .9}),
], OUT / 'vo')
DUR = V.duration + .8


def shots():
    ids = [s['id'] for s in STEPS]
    cues = {i: V.at(i) for i in ids}
    rows = []
    for k, i in enumerate(ids):
        nxt = cues[ids[k + 1]] - .8 if k + 1 < len(ids) else DUR
        rows.append((i, cues[i], min(V.lines[i]['end'] + .5, nxt)))
    return rows


if __name__ == '__main__':
    if sys.argv[1] == 'capture':
        # /usr/bin/chromium crashes in this sandbox; the page has no video, so Playwright's own build will do.
        from playwright.sync_api._generated import BrowserType
        _launch = BrowserType.launch
        BrowserType.launch = lambda self, **kw: _launch(self, **{k: v for k, v in kw.items() if k != 'executable_path'})
        walkfilm.capture(BASE + '/', STEPS, CAP, view=(1280, 720), dpr=1.5)
    else:
        F = walkfilm.Film(CAP, shots(), W=W, H=H)
        bed = Path.home() / '.local/share/uni/media-studio/beds/corner_say_bed.wav'
        wav = kit.write_wav(OUT / 'mix.wav', kit.mix_voice_bed(V.placed, DUR, bed))
        kit.render(F.frame, DUR, HERE / 't482-walkthrough.mp4', W, H, FPS, wav, workers=6, crf=23)
        print('duration', DUR)
