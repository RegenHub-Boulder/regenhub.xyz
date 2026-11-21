#!/usr/bin/env python3
"""T-482 book restyle: bring the email templates (and the newsletter, and the link landing page) onto the book's
palette and type: ink on a light paper leaf, moss for actions, a web-safe old-style serif stack. Idempotent."""
import re, sys
FILES = sys.argv[1:]
SERIF = "'EB Garamond', Garamond, 'Iowan Old Style', Palatino, Georgia, serif"
COLOURS = {
    "#2d5e3e": "#4b5a2c", "#2f6b3a": "#4b5a2c", "#7fb069": "#4b5a2c",   # greens -> moss
    "#1a1a1a": "#27231d", "#1f2a22": "#27231d", "#e8ece9": "#27231d",  # text -> ink
    "#555": "#514939", "#a8b0aa": "#514939",                          # secondary text
    "#888": "#6b6152", "#999": "#6b6152", "#7a857d": "#6b6152",       # quiet text
    "#e5e5e5": "#ddd5c4", "#eee": "#ddd5c4",                          # rules
    "#f0f4f1": "#efe9dc", "#0e1410": "#ebe6d9", "#ffffff": "#f4f0e6", # grounds
    "#cb904d": "#7a4f10", "#b45309": "#7a4f10", "#e07a5f": "#8e2f1d", # needs you / went wrong
}
for f in FILES:
    s = open(f).read()
    o = s
    s = re.sub(r"-apple-system,\s*BlinkMacSystemFont,\s*'Segoe UI',\s*sans-serif", SERIF, s)
    for a, b in COLOURS.items():
        s = re.sub(re.escape(a) + r"(?![0-9a-fA-F])", b, s)
    # buttons: square-ish like the site's
    s = re.sub(r"(background:\s*#4b5a2c;[^\"]*?border-radius:\s*)8px", r"\g<1>2px", s)
    # every letter's leaf: a light paper ground
    s = re.sub(r"(max-width:\s*560px;\s*margin:\s*0 auto;\s*padding:\s*24px;)(?!\s*background)", r"\1 background: #f4f0e6;", s)
    # kickers: italic, not capitals
    s = re.sub(r"text-transform:\s*uppercase;\s*letter-spacing:\s*0\.08em;", "font-style: italic;", s)
    if s != o:
        open(f, "w").write(s); print("restyled", f)
