"""Image URLs for PMC figures, from the PMC article page.

PMC's JATS XML names each figure's image file (`<graphic xlink:href>`) but not
where it's served: the CDN path has hash folders. The article page has the
full URL in each `<figure id>`'s `<img src>`, under the same ID as the JATS
`<fig id>` (docs/wps/discovery/README.md, DD3).
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
from urllib.parse import urlsplit

import httpx

from discovery.fulltext import FullText
from discovery.papers import ids_from_url
from discovery.sources import Skipped, raise_for_status

log = logging.getLogger(__name__)

PAGE = "https://pmc.ncbi.nlm.nih.gov/articles/{}/"
# PMC sometimes sends a small block page instead of the article: tries, and seconds between them.
TRIES = 3
RETRY_SECONDS = 2.0

_FIGURE = re.compile(r"<figure\b([^>]*)>(.*?)</figure>", re.I | re.S)
_ID = re.compile(r"""(?:^|\s)id\s*=\s*["']([^"']+)["']""", re.I)
_IMG = re.compile(r"""<img\b[^>]*?\ssrc\s*=\s*["']((?:https:)?//cdn\.ncbi\.nlm\.nih\.gov/[^"']+)["']""", re.I)
_EXTENSION = re.compile(r"\.(jpe?g|png|gif|tiff?|webp|svg)$", re.I)


def parse_page(page: str) -> dict[str, str]:
    """The first CDN image in each `<figure>` of a PMC article page, by figure ID and by file stem."""
    urls: dict[str, str] = {}
    for attrs, inner in _FIGURE.findall(page):
        if not (img := _IMG.search(inner)):
            continue
        url = html.unescape(img.group(1))
        url = "https:" + url if url.startswith("//") else url
        urls.setdefault(stem(urlsplit(url).path.rsplit("/", 1)[-1]), url)
        if figure_id := _ID.search(attrs):
            urls[figure_id.group(1)] = url
    return urls


def stem(name: str) -> str:
    """An image file name without its image extension ("pone.0123.g001.jpg" → "pone.0123.g001")."""
    return _EXTENSION.sub("", name)


async def page_urls(client: httpx.AsyncClient, pmcid: str) -> dict[str, str]:
    """`parse_page` of the PMC article page. A page without a `<figure` is a block page: it's
    fetched twice more, `RETRY_SECONDS` apart, then `Skipped` says so."""
    for attempt in range(TRIES):
        if attempt:
            await asyncio.sleep(RETRY_SECONDS)
        response = await client.get(PAGE.format(pmcid))
        if response.status_code == 404:
            raise_for_status(response)
        if response.is_success and "<figure" in response.text:
            return parse_page(response.text)
    raise Skipped(f"PMC's article page was a block page {TRIES} times")


async def add_image_urls(client: httpx.AsyncClient, text: FullText) -> None:
    """Fill in the image URL of each figure of a PMC full text, matched by figure ID, then by
    image file. When none is found, `text.imagesSkipped` says why; nothing is raised."""
    pmcid = ids_from_url(text.url or "").get("pmcid")
    if text.source != "pmc" or not text.figures or not pmcid:
        return
    try:
        urls = await page_urls(client, pmcid)
    except (Skipped, httpx.HTTPError) as error:
        reason = str(error).split("\n")[0] or type(error).__name__
        log.warning("No figure images for %s: %s", pmcid, reason)
        text.imagesSkipped = f"figure images: {reason}"
        return
    for figure in text.figures:
        figure.imageUrl = urls.get(figure.figureId) or (urls.get(stem(figure.graphic)) if figure.graphic else None)
    if not any(figure.imageUrl for figure in text.figures):
        text.imagesSkipped = "figure images: no figure on PMC's article page matched"


def lacks_image_urls(text: FullText) -> bool:
    """A PMC full text saved before figures had image URLs: none has one, and nothing says why."""
    return (
        text.source == "pmc"
        and bool(text.figures)
        and text.imagesSkipped is None
        and not any(figure.imageUrl for figure in text.figures)
    )
