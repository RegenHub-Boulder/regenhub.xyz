"""T-485 walkthrough: buy a day pass with USDC on regenhub.xyz (local preview, sample data, fake chain). 16:9, narrated.
Uses the video lab's walkthrough template (~/Code/unforced-media/video-lab/tools, read-only).

    # capture: run the preview (WALKTHROUGH.md), then the real flow with the test wallet writes the walkfilm capture
    FILM_CAP=/tmp/t485-film/cap node apps/web/test/preview/walkthrough.mjs walkthrough
    ~/Code/unforced-media/video-lab/.venv/bin/python walkthrough/film.py   # -> walkthrough/t485-walkthrough.mp4
"""
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
LAB = Path.home() / 'Code/unforced-media/video-lab'
sys.path.insert(0, str(LAB / 'tools'))
import kit  # noqa: E402
import walkfilm  # noqa: E402
from wordlock import Voice  # noqa: E402

OUT = Path(os.environ.get('FILM_OUT', '/tmp/t485-film'))
CAP = OUT / 'cap'
W, H, FPS = 1920, 1080, 24
PW, PH = 470, 1017          # the phone screen, 390x844 CSS px at 1.2x: its real size on a laptop
PX, PY = 300, 32
BG = (24, 40, 31)
INK = (226, 232, 214)
GOLD = (232, 176, 75)
MUTED = (150, 168, 150)

STEPS = ['buy', 'usdc', 'wallet', 'review', 'authorize', 'added', 'activity', 'admin', 'audit']
WORDS = {
    'buy': ('$30', 'or $25 at the member rate'),
    'usdc': ('Pay with USDC', 'next to Pay with card'),
    'wallet': ('Sign once', 'to prove the wallet is yours'),
    'review': ('Price held', 'for an hour, exact amount'),
    'authorize': ('Checked on chain', 'RegenHub pays the gas'),
    'added': ('+1 pass', 'and a receipt by email'),
    'activity': ('Paid in USDC', 'in your activity'),
    'admin': ('Admins see it', 'billing tab'),
    'audit': ('Credited once', 'never on a wrong amount'),
}
V = Voice([
    ('buy', 'This is the day pass page, on a local preview with sample data. A [buy]pass is thirty dollars, or twenty five at the member rate.', {'gap': .7}),
    ('usdc', 'Next to Pay with card, there is now [usdc]Pay with U S D C.', {'gap': .7}),
    ('wallet', 'Pick a wallet. The [wallet]first time, you sign once, to prove it is yours.', {'gap': .6}),
    ('review', 'The price is then [review]held for an hour, and you see the exact payment you are approving.', {'gap': .6}),
    ('authorize', '[authorize]Approve it. RegenHub sends it, pays the gas, and checks the transfer on chain.', {'gap': .7}),
    ('added', 'Once it checks out, the [added]pass is in your balance, and a receipt goes out by email.', {'gap': .6}),
    ('activity', 'It shows in your [activity]activity, marked paid in U S D C.', {'gap': .7}),
    ('admin', 'Admins see it on the [admin]billing tab,', {'gap': .3}),
    ('audit', 'and in the [audit]activity log, with the transaction. A payment is credited once, and never on a wrong amount.', {'gap': .6}),
], OUT / 'vo')
DUR = V.duration + .8


def shots():
    cues = {i: V.at(i) for i in STEPS}
    rows = []
    for k, i in enumerate(STEPS):
        nxt = cues[STEPS[k + 1]] - .8 if k + 1 < len(STEPS) else DUR
        rows.append((i, cues[i], min(V.lines[i]['end'] + .5, nxt)))
    return rows


F = walkfilm.Film(CAP, shots(), W=PW, H=PH, tone=(232, 176, 75))
BIG, SMALL, HEAD = kit.font(kit.SANS, 92, 600), kit.font(kit.SANS, 40), kit.font(kit.SANS, 28)


def frame(t):
    img = Image.new('RGB', (W, H), BG)
    phone = Image.fromarray(F.frame(t))
    mask = Image.new('L', (PW, PH), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, PW - 1, PH - 1), 28, fill=255)
    img.paste(phone, (PX, PY), mask)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((PX - 3, PY - 3, PX + PW + 2, PY + PH + 2), 30, outline=(70, 96, 78), width=3)
    d.text((900, 70), 'regenhub.xyz  ·  local preview, sample data, test chain', font=HEAD, fill=MUTED)
    # the step's word, as it is said; it stays until the next one
    cur = None
    for i in STEPS:
        if t >= V.at(i) - .1:
            cur = i
    if cur:
        a = min(1.0, (t - (V.at(cur) - .1)) / .3)
        big, small = WORDS[cur]
        col = tuple(int(BG[c] + (GOLD[c] - BG[c]) * a) for c in range(3))
        sub = tuple(int(BG[c] + (INK[c] - BG[c]) * a) for c in range(3))
        d.text((900, 430), big, font=BIG, fill=col)
        d.text((904, 550), small, font=SMALL, fill=sub)
    return np.asarray(img)


if __name__ == '__main__':
    bed = Path.home() / '.local/share/uni/media-studio/beds/corner_say_bed.wav'
    wav = kit.write_wav(OUT / 'mix.wav', kit.mix_voice_bed(V.placed, DUR, bed))
    kit.render(frame, DUR, HERE / 't485-walkthrough.mp4', W, H, FPS, wav, workers=6, crf=23, pictures=12)
    print('duration', round(DUR, 1))
