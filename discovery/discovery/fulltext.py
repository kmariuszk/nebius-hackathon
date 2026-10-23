"""A paper's full text: where it comes from, how it's cut to size, and quote checks.

The reader agent works from this text (docs/Concept.md, pipeline step 9). The
sources are tried in order: PMC's JATS XML, arXiv's HTML page, then the
open-access PDF or landing page through Tavily Extract, and the abstract as a
last resort, marked `source: "abstract"` so the reader says its summary is
abstract-only.
"""

from __future__ import annotations

import re
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from typing import Any, Literal
from urllib.parse import quote

Source = Literal["pmc", "web", "abstract"]

# Characters of text handed to the reader by default, about 10k tokens.
DEFAULT_MAX_CHARS = 40_000
# Extracted pages shorter than this are a landing page or a paywall, not the paper.
MIN_WEB_CHARS = 3_000
# Below this much budget left, a section is omitted rather than cut to a stub.
MIN_SECTION_CHARS = 300

# Back matter that says nothing about the science.
_BOILERPLATE = re.compile(
    r"acknowledg|author contribution|conflicts? of interest|competing interest|funding|"
    r"publisher.s note|ethics statement|data availability|supplementary|extended data|reporting summary",
    re.I,
)
_METHODS = re.compile(r"\b(methods|materials)\b", re.I)
# Tags whose text isn't part of the running prose: floats are listed as figures instead.
_SKIP_TAGS = {"fig", "table-wrap", "fig-group", "supplementary-material", "disp-formula"}
_XLINK_HREF = "{http://www.w3.org/1999/xlink}href"


@dataclass
class Section:
    title: str
    text: str


@dataclass
class Figure:
    figureId: str
    label: str
    caption: str
    imageUrl: str | None = None  # from PMC's article page (discovery/figures.py)
    graphic: str | None = None  # the image file JATS names, to match when the IDs don't

    def to_summary(self) -> dict[str, Any]:
        return {"figureId": self.figureId, "label": self.label, "caption": self.caption, "imageUrl": self.imageUrl}


@dataclass
class FullText:
    source: Source
    url: str | None
    sections: list[Section]
    figures: list[Figure] = field(default_factory=list)
    # Why no figure has an image URL, once that was looked up and none was found.
    imagesSkipped: str | None = None

    def to_record(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> FullText:
        return cls(
            source=record["source"],
            url=record.get("url"),
            sections=[Section(**s) for s in record["sections"]],
            figures=[
                Figure(f["figureId"], f["label"], f["caption"], f.get("imageUrl"), f.get("graphic"))
                for f in record.get("figures", [])
            ],
            imagesSkipped=record.get("imagesSkipped"),
        )

    def chars(self) -> int:
        return sum(len(s.text) for s in self.sections)

    def fit(self, max_chars: int) -> dict[str, Any]:
        """The sections to hand the reader, Methods last, cut at `max_chars`.

        No section takes more than a sixth of the budget, so one long section
        can't crowd out the results and discussion after it.
        """
        ordered = sorted(self.sections, key=lambda s: bool(_METHODS.search(s.title)))
        cap = max(max_chars // 6, MIN_SECTION_CHARS)
        kept, omitted, left = [], [], max_chars
        for section in ordered:
            if left < MIN_SECTION_CHARS:
                omitted.append(section.title)
                continue
            room = min(left, cap)
            text = section.text if len(section.text) <= room else section.text[:room].rsplit(" ", 1)[0] + " …"
            kept.append({"title": section.title, "text": text})
            left -= len(text)
        truncated = bool(omitted) or any(k["text"] != s.text for k, s in zip(kept, ordered))
        return {"sections": kept, "truncated": truncated, "omittedSections": omitted}

    def find(self, passage: str) -> Section | None:
        """The section `passage` appears in word for word, ignoring spacing, quote styles and markup."""
        needle = _plain(passage)
        if len(needle) < 10:
            return None
        return next((s for s in self.sections if needle in _plain(s.text)), None)


def from_jats(xml_text: str, url: str | None, abstract: str | None) -> FullText | None:
    """The body and figures of a PMC article; None when PMC withholds the body."""
    root = ET.fromstring(xml_text)
    article = root if root.tag == "article" else root.find("article")
    body = article.find("body") if article is not None else None
    if body is None:
        return None
    sections = [Section("Abstract", abstract)] if abstract else []
    loose = " ".join(_prose(p) for p in body if p.tag == "p")
    if loose.strip():
        sections.append(Section("Main text", loose))
    for sec in body.findall("sec"):
        title = _plain_text(sec.find("title")) or "Untitled section"
        if _BOILERPLATE.search(title):
            continue
        if text := _sec_text(sec):
            sections.append(Section(title, text))
    if sum(len(s.text) for s in sections) - len(abstract or "") < MIN_WEB_CHARS:
        return None
    figures = []
    for fig in article.iter("fig"):
        caption = fig.find("caption")
        graphic = fig.find(".//graphic")
        figures.append(
            Figure(
                figureId=fig.get("id") or f"fig{len(figures) + 1}",
                label=_plain_text(fig.find("label")),
                # The caption's title and paragraphs, which itertext would run together.
                caption=" ".join(filter(None, map(_plain_text, caption if caption is not None else [])))[:600],
                graphic=graphic.get(_XLINK_HREF) if graphic is not None else None,
            )
        )
    return FullText("pmc", url, sections, figures)


def from_markdown(markdown: str, url: str) -> FullText | None:
    """An extracted web page, split at its headings; None when it's too short to be the paper."""
    markdown = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", markdown)  # Images.
    markdown = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", markdown)  # Links keep their text.
    if len(markdown) < MIN_WEB_CHARS:
        return None
    sections, title, lines = [], "Main text", []
    for line in markdown.splitlines():
        if heading := re.match(r"#{1,6}\s+(.+)", line):
            if text := " ".join(" ".join(lines).split()):
                sections.append(Section(title, text))
            title, lines = heading.group(1).strip(), []
        else:
            lines.append(line)
    if text := " ".join(" ".join(lines).split()):
        sections.append(Section(title, text))
    # Short bits between headings are page furniture (menus, banners), not the paper.
    sections = [
        s for s in sections
        if len(s.text) >= 100 and not _BOILERPLATE.search(s.title) and s.title.lower() != "references"
    ]
    return FullText("web", url, sections)


def from_abstract(abstract: str | None, url: str | None) -> FullText:
    return FullText("abstract", url, [Section("Abstract", abstract)] if abstract else [])


def text_link(url: str | None, passage: str) -> str | None:
    """`url` with a text fragment that scrolls to and highlights `passage` in the browser."""
    if not url:
        return None
    words = passage.split()
    encode = lambda text: quote(text, safe="")  # noqa: E731
    fragment = (
        encode(" ".join(words))
        if len(words) <= 10
        else f"{encode(' '.join(words[:5]))},{encode(' '.join(words[-5:]))}"
    )
    return f"{url.split('#')[0]}#:~:text={fragment}"


def _sec_text(sec: ET.Element) -> str:
    parts = []
    for child in sec:
        if child.tag == "p":
            parts.append(_prose(child))
        elif child.tag == "sec":
            sub = _plain_text(child.find("title"))
            text = _sec_text(child)
            parts.append(f"{sub}. {text}" if sub and text else text)
    return " ".join(p for p in parts if p)


def _prose(element: ET.Element) -> str:
    """The element's text without figures, tables or formulas."""
    parts = [element.text or ""]
    for child in element:
        if child.tag not in _SKIP_TAGS:
            parts.append(_prose(child))
        parts.append(child.tail or "")
    return " ".join("".join(parts).split())


def _plain_text(element: ET.Element | None) -> str:
    return " ".join("".join(element.itertext()).split()) if element is not None else ""


_QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "−": "-"})


def _plain(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).translate(_QUOTES)
    text = re.sub(r"[*_`]", "", text)
    return " ".join(text.split())
