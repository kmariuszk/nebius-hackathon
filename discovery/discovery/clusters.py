"""`cluster_papers`: a set of papers in groups of similar papers, each named by Lightning.

The groups come from the papers' embeddings, not a model's judgement: k-means++
with cosine similarity on the stored unit vectors, in numpy, seeded so the same
papers always give the same groups (decision DD1 in docs/wps/discovery/README.md).
A cluster's ID comes from its medoid, its most central paper (DD2), so adding a
paper rarely changes it and the board's `apply_clusters` fills the same frame.
Lightning names each cluster from its titles, one request per cluster (DD4).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
from typing import Any

import httpx
import numpy as np

from discovery.citations import _load
from discovery.embeddings import Embedder
from discovery.rerank import TOKEN_FACTORY_URL
from discovery.service import Discovery
from discovery.sources import Skipped, key

log = logging.getLogger(__name__)

MIN_PAPERS, MAX_PAPERS = 2, 500
MAX_K = 6
ITERATIONS = 25
SEED = 0
RESTARTS = 10  # k-means++ runs from the one seed; the tightest wins
NEIGHBOURS = 3
LIGHTNING = "nvidia/Nemotron-3_5-Lightning"
TITLES = 8  # member titles Lightning sees per cluster
LABEL_CHARS = 60  # the canvas's label_cluster takes at most 60
LABEL_TIMEOUT = 60.0
PROMPT = (
    "Name this group of papers in 2 to 4 words a biologist would use, from their titles. "
    'Reply {"label": "…"}'
)
_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")


# ---- pure functions over a matrix of unit vectors, one row per paper


def choose_k(n: int, k: int | None = None) -> int:
    """`k` if given (at most `n`); else 1 under 6 papers, else round(sqrt(n / 2)) within 2 to 6."""
    if k is not None:
        return max(1, min(k, n))
    if n < 6:
        return 1
    return min(MAX_K, max(2, round(math.sqrt(n / 2))))


def kmeans(vectors: np.ndarray, k: int, seed: int = SEED, iterations: int = ITERATIONS) -> np.ndarray:
    """Each row's cluster: the best of `RESTARTS` k-means++ runs by cosine similarity, each at most
    `iterations` rounds. Some clusters may be empty; the same rows and seed always give the same answer."""
    rng = np.random.default_rng(seed)
    best, score = np.zeros(len(vectors), dtype=int), -np.inf
    for _ in range(RESTARTS):
        labels, centroids = _kmeans_once(vectors, k, rng, iterations)
        if (total := float((vectors * centroids[labels]).sum())) > score:
            best, score = labels, total
    return best


def _kmeans_once(
    vectors: np.ndarray, k: int, rng: np.random.Generator, iterations: int
) -> tuple[np.ndarray, np.ndarray]:
    """One k-means++ run: each row's cluster and the clusters' centroids."""
    n = len(vectors)
    centres = [vectors[rng.integers(n)]]
    for _ in range(1, k):
        # 1 - cosine is half the squared distance between unit vectors: k-means++'s D² weights
        distance = np.clip(1 - (vectors @ np.stack(centres).T).max(axis=1), 0, None).astype(np.float64)
        if distance.sum() <= 0:
            break  # every row is a centre already
        centres.append(vectors[rng.choice(n, p=distance / distance.sum())])
    centroids = np.stack(centres)
    labels = np.full(n, -1)
    for _ in range(iterations):
        assigned = (vectors @ centroids.T).argmax(axis=1)
        if np.array_equal(assigned, labels):
            break
        labels = assigned
        for c in range(len(centroids)):
            if (members := labels == c).any():
                centroids[c] = _unit(vectors[members].mean(axis=0))
    return labels, centroids


def merge_singletons(vectors: np.ndarray, labels: np.ndarray) -> list[list[int]]:
    """The clusters as lists of rows, empty ones dropped and each cluster of one row merged into
    the cluster whose centroid is closest, until none is left (or only one cluster)."""
    clusters = [[int(i) for i in np.flatnonzero(labels == c)] for c in np.unique(labels)]
    while len(clusters) > 1 and (alone := next((c for c in clusters if len(c) == 1), None)):
        clusters = [c for c in clusters if c is not alone]
        centroids = np.stack([_unit(vectors[c].mean(axis=0)) for c in clusters])
        clusters[int((centroids @ vectors[alone[0]]).argmax())].append(alone[0])
    return [sorted(c) for c in clusters]


def medoid(vectors: np.ndarray, rows: list[int]) -> int:
    """The row with the highest mean similarity to the cluster's other rows (the first on a tie)."""
    if len(rows) == 1:
        return rows[0]
    similarity = vectors[rows] @ vectors[rows].T
    mean = (similarity.sum(axis=1) - similarity.diagonal()) / (len(rows) - 1)
    return rows[int(mean.argmax())]


def by_similarity(vectors: np.ndarray, rows: list[int], centre: int) -> list[int]:
    """The rows, most similar to `centre` first (so `centre` leads), ties in row order."""
    similarity = vectors[rows] @ vectors[centre]
    similarity[rows.index(centre)] = np.inf
    return [rows[i] for i in np.argsort(-similarity, kind="stable")]


def neighbours(vectors: np.ndarray, n: int = NEIGHBOURS) -> list[tuple[int, int, float]]:
    """Each row's `n` most similar other rows as (row, other, cosine), each pair once."""
    similarity = vectors @ vectors.T
    np.fill_diagonal(similarity, -np.inf)
    pairs, seen = [], set()
    for a in range(len(vectors)):
        for b in np.argsort(-similarity[a], kind="stable")[: min(n, len(vectors) - 1)]:
            if (pair := frozenset((a, int(b)))) not in seen:
                seen.add(pair)
                pairs.append((a, int(b), float(similarity[a, b])))
    return pairs


def cluster_id(paper_id: str) -> str:
    """A cluster's ID from its medoid's paper ID: "c-" and the ID with every code point outside
    [A-Za-z0-9_-] as "_", the slug rule of client/shared/ids.ts."""
    return "c-" + _UNSAFE.sub("_", paper_id)


def group(vectors: np.ndarray, paper_ids: list[str], k: int | None = None) -> dict[str, Any]:
    """`clusters` (biggest first, labels still None) and `similarities` for papers with these unit vectors."""
    rows = merge_singletons(vectors, kmeans(vectors, choose_k(len(paper_ids), k)))
    found, used = [], set()
    for members in sorted(rows, key=lambda c: (-len(c), c[0])):
        centre = medoid(vectors, members)
        cid = cluster_id(paper_ids[centre])
        while cid in used:  # two medoids whose IDs have the same slug
            cid += "_"
        used.add(cid)
        found.append({
            "clusterId": cid,
            "paperIds": [paper_ids[i] for i in by_similarity(vectors, members, centre)],
            "label": None,
        })
    similarities = [
        {"a": paper_ids[a], "b": paper_ids[b], "similarity": round(s, 3)} for a, b, s in neighbours(vectors)
    ]
    return {"clusters": found, "similarities": similarities}


# ---- the tool


async def cluster_papers(discovery: Discovery, paper_ids: list[str], k: int | None = None) -> dict[str, Any]:
    """`clusters` ({clusterId, paperIds, label}), `similarities` ({a, b, similarity}) and `skipped`, all
    under the IDs given. Papers that can't be loaded or embedded are in `skipped` and in no cluster.

    Raises `ValueError` unless 2 to 500 different IDs are given and at least 2 can be embedded, and
    `Skipped` without an embeddings key.
    """
    unique = list(dict.fromkeys(paper_ids))
    if not MIN_PAPERS <= len(unique) <= MAX_PAPERS:
        raise ValueError(f"Give {MIN_PAPERS} to {MAX_PAPERS} different paper IDs, not {len(unique)}")
    if k is not None and k < 1:
        raise ValueError("k must be at least 1, or left out")
    embedder = Embedder.from_env(discovery.client)
    papers, skipped = await _load(discovery, unique)
    stored, failures = await discovery._paper_vectors(embedder, list(papers.values()))
    ids = []
    for paper_id, paper in papers.items():
        if paper.paper_id in stored:
            ids.append(paper_id)
        else:
            skipped.append(f"paper {paper_id}: not embedded: {failures.get(paper.paper_id, 'no vector')}")
    if len(ids) < MIN_PAPERS:
        raise ValueError(f"Fewer than {MIN_PAPERS} of the papers could be loaded and embedded: {'; '.join(skipped)}")
    result = group(np.stack([stored[papers[paper_id].paper_id] for paper_id in ids]), ids, k)
    titles = {paper_id: papers[paper_id].title for paper_id in ids}
    labels = await asyncio.gather(
        *(label(discovery.client, [titles[p] for p in c["paperIds"][:TITLES]]) for c in result["clusters"])
    )
    for cluster, name in zip(result["clusters"], labels):
        cluster["label"] = name
    return {**result, "skipped": skipped}


def lightning_model() -> str:
    return os.environ.get("LIGHTNING_MODEL", "").strip() or LIGHTNING


async def label(client: httpx.AsyncClient, titles: list[str]) -> str | None:
    """Lightning's 2-to-4-word name for papers with these titles; None if the call fails or names nothing."""
    try:
        base = os.environ.get("TF_BASE_URL", "").strip() or TOKEN_FACTORY_URL
        headers = {"Authorization": f"Bearer {key('TF_API_KEY', 'Nebius Token Factory')}"}
        body = {
            "model": lightning_model(),
            "messages": [{"role": "user", "content": PROMPT + "\n\n" + "\n".join(f"- {t}" for t in titles)}],
            "response_format": {"type": "json_object"},
            "temperature": 0,
            "max_tokens": 2000,
        }
        post = client.post(base.rstrip("/") + "/chat/completions", json=body, headers=headers, timeout=LABEL_TIMEOUT)
        response = await asyncio.wait_for(post, LABEL_TIMEOUT)  # in all, not only between bytes
        response.raise_for_status()
        name = parse_label(response.json()["choices"][0]["message"].get("content") or "")
    except (Skipped, httpx.HTTPError, TimeoutError, ValueError, KeyError, IndexError, TypeError,
            AttributeError) as error:
        log.warning("Lightning couldn't name a cluster: %s: %s", type(error).__name__, error)
        return None
    if name is None:
        log.warning("Lightning gave no name for a cluster")
    return name


def parse_label(content: str) -> str | None:
    """The `label` in the reply, also inside a code fence or prose; None when there is none."""
    decoder = json.JSONDecoder()
    for start in (i for i, char in enumerate(content) if char == "{"):
        try:
            value, _ = decoder.raw_decode(content, start)
        except ValueError:
            continue
        if isinstance(value, dict) and isinstance(value.get("label"), str):
            name = " ".join(value["label"].split()).strip("\"'.")
            return name[:LABEL_CHARS].strip() or None
    return None


def _unit(vector: np.ndarray) -> np.ndarray:
    return vector / (np.linalg.norm(vector) or 1.0)
