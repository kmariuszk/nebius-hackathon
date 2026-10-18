"""arXiv's export API, for arXiv papers that PubMed doesn't index. No key needed."""

from __future__ import annotations

import xml.etree.ElementTree as ET

import httpx

from discovery.papers import Paper
from discovery.sources import Throttle

URL = "https://export.arxiv.org/api/query"
_ATOM = "{http://www.w3.org/2005/Atom}"
_ARXIV = "{http://arxiv.org/schemas/atom}"
_throttle = Throttle(1)


async def papers(client: httpx.AsyncClient, arxiv_ids: list[str]) -> list[Paper]:
    if not arxiv_ids:
        return []
    await _throttle.wait()
    response = await client.get(URL, params={"id_list": ",".join(arxiv_ids), "max_results": len(arxiv_ids)})
    response.raise_for_status()
    return parse_feed(response.text)


def parse_feed(xml_text: str) -> list[Paper]:
    found = []
    for entry in ET.fromstring(xml_text).iter(f"{_ATOM}entry"):
        arxiv_id = (entry.findtext(f"{_ATOM}id") or "").rsplit("/abs/", 1)[-1]
        title = " ".join((entry.findtext(f"{_ATOM}title") or "").split())
        if not arxiv_id or not title:
            continue
        published = entry.findtext(f"{_ATOM}published") or ""
        found.append(
            Paper(
                ids={"arxiv": arxiv_id, "doi": entry.findtext(f"{_ARXIV}doi") or ""},
                title=title,
                authors=[a.findtext(f"{_ATOM}name") or "" for a in entry.iter(f"{_ATOM}author")],
                year=int(published[:4]) if published[:4].isdigit() else None,
                venue="arXiv",
                abstract=" ".join((entry.findtext(f"{_ATOM}summary") or "").split()) or None,
                open_access_pdf=f"https://arxiv.org/pdf/{arxiv_id}",
                type="preprint",
            )
        )
    return found
