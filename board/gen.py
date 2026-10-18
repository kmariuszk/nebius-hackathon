"""Helpers for generating Miro Canvas Composer SVG for the hackathon board."""
from xml.sax.saxutils import escape
import os

OUT = os.path.dirname(os.path.abspath(__file__))
FONT = 'font-family="noto_sans"'
INK, BODY = "#1a1a1a", "#595959"
GREY = "#f7f7f7"
BLUE_F, BLUE_L, BLUE_D = "#f0f5fd", "#c6dcff", "#305bab"
YEL_L = "#fff6b6"
HEAT = {1: ("#f7f7f7", INK), 2: ("#eaf9ef", INK), 3: ("#adf0c7", INK),
        4: ("#2dc75c", INK), 5: ("#067429", "#ffffff")}
W = 3080
PAD = 64


def attr(s):
    return escape(s, {'"': "&quot;"})


def text(x, y, s, size, color=INK, bold=False):
    b = ' font-weight="bold"' if bold else ""
    return f'<text x="{x}" y="{y}" {FONT} font-size="{size}"{b} fill="{color}">{escape(s)}</text>'


def area(x, y, w, body, size=22, color=BODY):
    # body is trusted inline markup (<b>, <i>, <br/>)
    return f'<textArea x="{x}" y="{y}" width="{w}" {FONT} font-size="{size}" fill="{color}">{body}</textArea>'


def box(x, y, w, h, fill, content=None, size=22, color=INK, align="left", valign="top", rx=12):
    c = ""
    if content is not None:
        c = (f' data-content="{attr(content)}" data-text-color="{color}" data-font-family="noto_sans"'
             f' data-font-size="{size}" data-text-align="{align}" data-text-align-vertical="{valign}"')
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="none"{c} />'


def frame(fid, tx, ty, h, title, children):
    inner = "\n    ".join(children)
    return (f'<g id="{fid}" transform="translate({tx},{ty})" data-frame="{attr(title)}">\n'
            f'    <rect data-type="frame" x="0" y="0" width="{W}" height="{h}" fill="#ffffff" data-title="{attr(title)}" />\n'
            f'    {inner}\n</g>')


def svg(*mods):
    return '<svg xmlns="http://www.w3.org/2000/svg">\n' + "\n".join(mods) + "\n</svg>\n"


def header(num_title, instruction):
    return [text(PAD, 128, num_title, 67, bold=True),
            area(PAD, 160, W - 2 * PAD, instruction)]
