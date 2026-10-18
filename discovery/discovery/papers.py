"""Paper records and their identifiers.

A paper ID is a prefixed identifier: `doi:10.1038/…`, `pmid:34290406`,
`pmcid:PMC9187974`, `arxiv:2401.01234`, `openalex:W2741809807` or `s2:<sha>`.
A paper keeps the first ID it was stored under, and every other identifier it
has resolves to it (see `store.py`), so one paper never shows up twice.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, fields
from typing import Any

# Order of preference for a new paper's ID: DOIs are the most widely shared.
ID_KINDS = ("doi", "pmid", "pmcid", "arxiv", "openalex", "s2")


def normalise(kind: str, value: str) -> str:
    value = value.strip()
    if kind == "doi":
        value = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:)", "", value, flags=re.I)
        return value.lower()
    if kind == "pmcid":
        return "PMC" + re.sub(r"^PMC", "", value, flags=re.I)
    if kind == "arxiv":
        return re.sub(r"v\d+$", "", re.sub(r"^arxiv:", "", value, flags=re.I))
    if kind == "openalex":
        return value.rsplit("/", 1)[-1].upper()
    return value


def parse_id(paper_id: str) -> tuple[str, str]:
    """Split `kind:value`; raises ValueError for an unknown kind."""
    kind, sep, value = paper_id.partition(":")
    kind = kind.lower()
    if not sep or kind not in ID_KINDS or not value.strip():
        raise ValueError(
            f"Unknown paper ID {paper_id!r}: expected one of "
            + ", ".join(f"{k}:…" for k in ID_KINDS)
        )
    return kind, normalise(kind, value)


def format_id(kind: str, value: str) -> str:
    return f"{kind}:{normalise(kind, value)}"


@dataclass
class Paper:
    ids: dict[str, str]
    title: str
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    venue: str | None = None
    abstract: str | None = None
    url: str | None = None
    open_access_pdf: str | None = None
    type: str | None = None
    paper_id: str | None = None  # Set by the store.

    def __post_init__(self) -> None:
        self.ids = {kind: normalise(kind, value) for kind, value in self.ids.items() if value}

    def aliases(self) -> list[str]:
        return [format_id(kind, self.ids[kind]) for kind in ID_KINDS if kind in self.ids]

    def preferred_id(self) -> str:
        aliases = self.aliases()
        if not aliases:
            raise ValueError(f"Paper {self.title!r} has no identifiers")
        return aliases[0]

    def merge(self, other: Paper) -> Paper:
        """This record with gaps filled from `other`; this record's values win."""
        merged = {f.name: getattr(self, f.name) for f in fields(self)}
        for f in fields(self):
            if f.name == "ids":
                merged["ids"] = {**other.ids, **self.ids}
            elif not merged[f.name]:
                merged[f.name] = getattr(other, f.name)
        return Paper(**merged)

    def embedding_text(self) -> str:
        """What the paper is embedded as: its title, and its abstract when there is one."""
        return f"{self.title}\n\n{self.abstract}" if self.abstract else self.title

    def to_record(self) -> dict[str, Any]:
        """The full record, in the camelCase shape of docs/Concept.md's paper record."""
        return {
            "paperId": self.paper_id or self.preferred_id(),
            "ids": dict(self.ids),
            "title": self.title,
            "authors": list(self.authors),
            "year": self.year,
            "venue": self.venue,
            "url": self.url or default_url(self.ids),
            "abstract": self.abstract,
            "openAccessPdf": self.open_access_pdf,
            "type": self.type,
        }

    def to_summary(self, found_by: list[str]) -> dict[str, Any]:
        """A short record for search results, small enough to list dozens of."""
        authors = self.authors[:3] + (["et al."] if len(self.authors) > 3 else [])
        abstract = self.abstract or ""
        if len(abstract) > 400:
            abstract = abstract[:400].rsplit(" ", 1)[0] + " …"
        return {
            "paperId": self.paper_id or self.preferred_id(),
            "title": self.title,
            "year": self.year,
            "venue": self.venue,
            "authors": authors,
            "url": self.url or default_url(self.ids),
            "abstract": abstract or None,
            "foundBy": found_by,
        }

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> Paper:
        return cls(
            ids=record["ids"],
            title=record["title"],
            authors=record.get("authors") or [],
            year=record.get("year"),
            venue=record.get("venue"),
            abstract=record.get("abstract"),
            url=record.get("url"),
            open_access_pdf=record.get("openAccessPdf"),
            type=record.get("type"),
            paper_id=record.get("paperId"),
        )


def default_url(ids: dict[str, str]) -> str | None:
    if "doi" in ids:
        return f"https://doi.org/{ids['doi']}"
    if "pmid" in ids:
        return f"https://pubmed.ncbi.nlm.nih.gov/{ids['pmid']}/"
    if "pmcid" in ids:
        return f"https://pmc.ncbi.nlm.nih.gov/articles/{ids['pmcid']}/"
    if "arxiv" in ids:
        return f"https://arxiv.org/abs/{ids['arxiv']}"
    return None


_URL_PATTERNS = [
    ("pmid", re.compile(r"pubmed\.ncbi\.nlm\.nih\.gov/(\d+)")),
    ("pmcid", re.compile(r"(?:pmc\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov/pmc)/articles/(PMC\d+)", re.I)),
    ("arxiv", re.compile(r"arxiv\.org/(?:abs|pdf|html)/(\d{4}\.\d{4,5})")),
    # bioRxiv and medRxiv DOIs end in a date and a number (prefix 10.1101, or 10.64898 since openRxiv).
    ("doi", re.compile(r"(?:bio|med)rxiv\.org/content/(10\.\d{4,5}/\d{4}\.\d{2}\.\d{2}\.\d+)")),
    ("doi", re.compile(r"\b(10\.\d{4,9}/[^\s?#]+?)(?:\.full|\.pdf|\.abstract)?(?:[?#]|$)")),
]


def ids_from_url(url: str) -> dict[str, str]:
    """The identifier a paper page's URL carries, if any (one kind at most)."""
    for kind, pattern in _URL_PATTERNS:
        if match := pattern.search(url):
            return {kind: normalise(kind, match.group(1))}
    return {}
