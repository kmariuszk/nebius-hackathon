"""`cluster_papers` on fixed vectors from a fake embeddings endpoint, with stubbed Lightning names (no network).

Each paper's vector is its group's axis plus a small fixed offset, so the
groups are tight and far apart, and the expected clusters are easy to read.
"""

import asyncio
import json
import time
from collections.abc import Callable
from pathlib import Path

import httpx
import numpy as np
import pytest
from mcp import Client

from discovery import clusters
from discovery.clusters import cluster_papers
from discovery.papers import Paper
from discovery.server import build_server
from discovery.service import Discovery
from discovery.store import Store
from discovery.vectors import VectorStore

PAPER_IDS = Path(__file__).parents[2] / "client" / "shared" / "fixtures" / "paper-ids.json"
TOPICS = ["Tumour ecosystem", "T cell exhaustion", "Heart failure"]
DIM = 8


def vector(group: int, i: int, spread: float = 0.05) -> list[float]:
    """Axis `group`, the group's core paper (`i` 0), plus a fixed offset of about `spread` for the others."""
    v = np.zeros(DIM)
    v[group] = 1.0
    return (v + spread * (i > 0) * np.random.default_rng(100 * group + i).standard_normal(DIM)).tolist()


def topic_of(titles: list[str]) -> str:
    return json.dumps({"label": titles[0].rsplit(" ", 1)[0]})


class FakeApis:
    """Embeddings by text from `vectors`; Lightning answers `name(titles)`: reply content, or a status code."""

    def __init__(self) -> None:
        self.vectors: dict[str, list[float]] = {}
        self.name: Callable[[list[str]], str | int] = topic_of
        self.replies: dict[str, str | int] = {}  # a model's one reply to every cluster, instead of `name`
        self.chats: list[httpx.Request] = []
        self.delay = 0.0  # seconds Lightning takes

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if request.url.path.endswith("/embeddings"):
            if any(text not in self.vectors for text in body["input"]):
                return httpx.Response(400)
            data = [{"index": i, "embedding": self.vectors[text]} for i, text in enumerate(body["input"])]
            return httpx.Response(200, json={"data": data})
        if request.url.path.endswith("/chat/completions"):
            self.chats.append(request)
            await asyncio.sleep(self.delay)
            reply = self.replies[body["model"]] if body["model"] in self.replies else self.name(titles(request))
            if isinstance(reply, int):
                return httpx.Response(reply)
            return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": reply}}]})
        return httpx.Response(404)


def titles(chat: httpx.Request) -> list[str]:
    prompt = json.loads(chat.content)["messages"][0]["content"]
    return [line.removeprefix("- ") for line in prompt.splitlines() if line.startswith("- ")]


@pytest.fixture
def apis(monkeypatch):
    monkeypatch.setenv("TF_API_KEY", "test-key")
    for name in ("EMBED_API_KEY", "EMBED_BASE_URL", "EMBED_MODEL", "LIGHTNING_MODEL", "SUPER_VL_MODEL", "TF_BASE_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr("discovery.embeddings.RETRY_WAITS", (0, 0))
    return FakeApis()


@pytest.fixture
def discovery(apis, tmp_path):
    client = httpx.AsyncClient(transport=httpx.MockTransport(apis))
    return Discovery(client, Store(), VectorStore(tmp_path / "vectors"))


def add(discovery, apis, pmid: str, title: str, v: list[float]) -> str:
    discovery.store.save(Paper(ids={"pmid": pmid}, title=title))
    apis.vectors[title] = v
    return f"pmid:{pmid}"


def groups(discovery, apis, *sizes: int) -> list[list[str]]:
    """A tight group of papers per size, one per topic; their IDs by group."""
    return [
        [add(discovery, apis, f"{g + 1}{i:02d}", f"{TOPICS[g]} {i}", vector(g, i)) for i in range(size)]
        for g, size in enumerate(sizes)
    ]


def members(result) -> list[list[str]]:
    return sorted(sorted(c["paperIds"]) for c in result["clusters"])


def unit(apis, discovery, paper_id: str) -> np.ndarray:
    v = np.asarray(apis.vectors[discovery.store.get(paper_id).title])
    return v / np.linalg.norm(v)


async def test_three_tight_groups_give_three_clusters_the_same_on_every_call(discovery, apis):
    a, b, c = groups(discovery, apis, 4, 4, 4)
    ids = [paper_id for trio in zip(a, b, c) for paper_id in trio]

    result = await cluster_papers(discovery, ids, k=3)

    assert members(result) == sorted(sorted(g) for g in (a, b, c))
    assert sorted(cluster["label"] for cluster in result["clusters"]) == sorted(TOPICS)
    for cluster in result["clusters"]:
        vectors = np.stack([unit(apis, discovery, p) for p in cluster["paperIds"]])
        similarity = vectors @ vectors.T
        # The medoid leads and names the cluster; the rest follow by similarity to it.
        assert int(((similarity.sum(axis=1) - 1) / 3).argmax()) == 0
        assert cluster["clusterId"] == "c-" + cluster["paperIds"][0].replace(":", "_")
        assert list(similarity[0, 1:]) == sorted(similarity[0, 1:], reverse=True)
    # Each paper's 3 nearest neighbours are the rest of its group: every pair in a group, once.
    pairs = {frozenset((s["a"], s["b"])) for s in result["similarities"]}
    assert len(pairs) == len(result["similarities"]) == 18
    assert pairs == {frozenset((x, y)) for g in (a, b, c) for x in g for y in g if x != y}
    assert all(s["similarity"] == round(s["similarity"], 3) and s["similarity"] > 0.9 for s in result["similarities"])
    assert result["skipped"] == []

    assert await cluster_papers(discovery, ids, k=3) == result


async def test_a_lone_paper_joins_the_nearest_cluster_and_no_cluster_has_one_paper(discovery, apis):
    a, b = groups(discovery, apis, 4, 4)
    # Far from both groups, a little closer to the first.
    lone = add(discovery, apis, "900", "Lone paper", [0.3, 0.1, 0, 0, 0, 0, 0, 1.0])

    result = await cluster_papers(discovery, a + b + [lone], k=3)

    assert members(result) == sorted([sorted(a + [lone]), sorted(b)])
    assert next(c for c in result["clusters"] if lone in c["paperIds"])["paperIds"][-1] == lone
    for k in (None, 2, 4, 5, 6, 9):
        found = await cluster_papers(discovery, a + b + [lone], k=k)
        assert min(len(c["paperIds"]) for c in found["clusters"]) >= 2, k


def test_a_cluster_of_one_merges_into_the_cluster_with_the_closest_centroid():
    vectors = np.array([[1, 0, 0], [0.9, 0.1, 0], [0, 1, 0], [0.1, 0.9, 0], [0.4, 0.2, 0.9]], dtype=np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    assert clusters.merge_singletons(vectors, np.array([0, 0, 1, 1, 2])) == [[0, 1, 4], [2, 3]]
    # Empty clusters are dropped, and singletons merge until none is left.
    assert clusters.merge_singletons(vectors, np.array([3, 3, 1, 4, 0])) == [[0, 1, 4], [2, 3]]
    assert clusters.merge_singletons(vectors[:1], np.array([0])) == [[0]]


async def test_adding_a_paper_close_to_a_cluster_keeps_every_cluster_id(discovery, apis):
    a, b, c = groups(discovery, apis, 6, 6, 6)
    before = await cluster_papers(discovery, a + b + c)  # 18 papers: k = 3
    new = add(discovery, apis, "250", "T cell exhaustion new", vector(1, 50))

    after = await cluster_papers(discovery, [new] + a + b + c)  # 19 papers: k = 3

    # Each cluster is named after its core paper, before and after.
    assert members(before) == sorted(sorted(g) for g in (a, b, c))
    assert sorted(cluster["clusterId"] for cluster in before["clusters"]) == ["c-pmid_100", "c-pmid_200", "c-pmid_300"]
    ids = {cluster["clusterId"]: cluster["paperIds"] for cluster in after["clusters"]}
    assert set(ids) == {cluster["clusterId"] for cluster in before["clusters"]}
    assert sorted(ids["c-pmid_200"]) == sorted(b + [new])


async def test_a_failed_or_empty_name_leaves_the_label_null_and_the_clusters_come_back(discovery, apis, caplog):
    a, b, c = groups(discovery, apis, 4, 4, 4)
    apis.name = lambda titles: {"Heart": 500, "T": "{}"}.get(titles[0].split()[0], topic_of(titles))

    result = await cluster_papers(discovery, a + b + c, k=3)

    labels = {tuple(sorted(cluster["paperIds"])): cluster["label"] for cluster in result["clusters"]}
    assert labels == {tuple(sorted(a)): "Tumour ecosystem", tuple(sorted(b)): None, tuple(sorted(c)): None}
    assert result["skipped"] == []
    # Super VL is asked after Lightning, and fails the same way here
    warnings = sorted(r.getMessage() for r in caplog.records if r.levelname == "WARNING")
    assert len(warnings) == 4
    assert warnings[0].startswith("Lightning couldn't name a cluster: HTTPStatusError: Server error '500")
    assert warnings[1] == "Lightning gave no name for a cluster"
    assert warnings[2].startswith("Super VL couldn't name a cluster: HTTPStatusError: Server error '500")
    assert warnings[3] == "Super VL gave no name for a cluster"


@pytest.mark.parametrize("lightning", [500, "no JSON here", '{"label": 3}'])
async def test_super_vl_names_the_clusters_lightning_couldnt(discovery, apis, lightning):
    apis.replies[clusters.LIGHTNING] = lightning
    a, b = groups(discovery, apis, 3, 3)

    result = await cluster_papers(discovery, a + b)

    assert sorted(cluster["label"] for cluster in result["clusters"]) == sorted(TOPICS[:2])
    bodies = [json.loads(chat.content) for chat in apis.chats]
    assert sorted(body["model"] for body in bodies) == sorted([clusters.LIGHTNING, "nvidia/Nemotron-3.5-Super-VL"] * 2)
    assert all(body["chat_template_kwargs"] == {"enable_thinking": False} for body in bodies)


async def test_a_programming_error_while_naming_is_not_hidden(discovery, apis, monkeypatch):
    def broken(content: str) -> str | None:
        return content.labels  # an AttributeError, as a typo would raise

    monkeypatch.setattr(clusters, "parse_label", broken)
    a, b = groups(discovery, apis, 3, 3)

    with pytest.raises(AttributeError):
        await cluster_papers(discovery, a + b)


async def test_a_lightning_that_never_answers_leaves_the_labels_null_in_time(discovery, apis, monkeypatch):
    monkeypatch.setattr(clusters, "LABEL_TIMEOUT", 0.2)
    apis.delay = 5
    a, b = groups(discovery, apis, 3, 3)

    started = time.monotonic()
    result = await cluster_papers(discovery, a + b)

    assert time.monotonic() - started < 2  # the requests ran in parallel and were given up on
    assert members(result) == sorted([sorted(a), sorted(b)])
    assert [cluster["label"] for cluster in result["clusters"]] == [None, None]


async def test_each_cluster_is_named_by_one_lightning_request_from_up_to_8_titles(discovery, apis, monkeypatch):
    monkeypatch.setenv("LIGHTNING_MODEL", "nvidia/lightning-test")
    a, b = groups(discovery, apis, 10, 3)
    apis.name = lambda titles: '```json\n{"label": " Tumour  ecosystem."}\n```'

    result = await cluster_papers(discovery, a + b, k=2)

    assert [cluster["label"] for cluster in result["clusters"]] == ["Tumour ecosystem", "Tumour ecosystem"]
    assert len(apis.chats) == 2
    chat = next(r for r in apis.chats if titles(r)[0].startswith("Tumour"))
    body = json.loads(chat.content)
    assert (body["model"], body["response_format"], body["temperature"], body["chat_template_kwargs"]) == (
        "nvidia/lightning-test", {"type": "json_object"}, 0, {"enable_thinking": False})
    assert body["messages"][0]["content"].startswith(clusters.PROMPT)
    # The cluster's 8 most central papers, in its order.
    assert titles(chat) == [discovery.store.get(p).title for p in result["clusters"][0]["paperIds"][:8]]
    assert chat.headers["Authorization"] == "Bearer test-key"
    assert chat.extensions["timeout"]["read"] == clusters.LABEL_TIMEOUT == 60


async def test_papers_that_cant_be_loaded_or_embedded_are_skipped(discovery, apis, monkeypatch):
    monkeypatch.setattr("discovery.embeddings.BATCH", 1)
    a, b = groups(discovery, apis, 3, 2)
    discovery.store.save(Paper(ids={"pmid": "777"}, title="No vector"))  # the fake has none for it

    result = await cluster_papers(discovery, [*a, "isbn:1", "pmid:777", *b, a[0]])

    assert members(result) == [sorted(a + b)]  # 5 papers clustered, under 6: one cluster
    assert [note.split(":")[0] for note in result["skipped"]] == ["paper isbn", "paper pmid"]
    assert result["skipped"][1].startswith("paper pmid:777: not embedded: embeddings answered HTTP 400")

    with pytest.raises(ValueError, match="Fewer than 2 of the papers could be loaded and embedded"):
        await cluster_papers(discovery, [a[0], "pmid:777"])
    with pytest.raises(ValueError, match="Give 2 to 500 different paper IDs, not 1"):
        await cluster_papers(discovery, [a[0], a[0]])


def test_k_follows_the_number_of_papers_unless_given():
    assert [clusters.choose_k(n) for n in (2, 5, 6, 12, 13, 18, 19, 32, 50, 72, 500)] == [
        1, 1, 2, 2, 3, 3, 3, 4, 5, 6, 6]
    assert (clusters.choose_k(12, 3), clusters.choose_k(4, 10), clusters.choose_k(40, 1)) == (3, 4, 1)


def test_cluster_ids_slug_the_medoid_id_like_the_board():
    for paper_id, shape_id in json.loads(PAPER_IDS.read_text()):
        assert clusters.cluster_id(paper_id) == "c-" + shape_id.removeprefix("shape:paper-")


async def test_cluster_papers_over_mcp(discovery, apis):
    a, b, c = groups(discovery, apis, 4, 4, 4)
    async with Client(build_server(discovery)) as client:
        assert "cluster_papers" in [tool.name for tool in (await client.list_tools()).tools]

        result = await client.call_tool("cluster_papers", {"paper_ids": a + b + c, "k": 3})
        assert not result.is_error
        assert members(result.structured_content) == sorted(sorted(g) for g in (a, b, c))
        assert set(result.structured_content) == {"clusters", "similarities", "skipped"}

        # k as a placeholder counts as left out: 12 papers make 2 clusters.
        result = await client.call_tool("cluster_papers", {"paper_ids": a + b + c, "k": "None"})
        assert not result.is_error and len(result.structured_content["clusters"]) == 2

        alone = await client.call_tool("cluster_papers", {"paper_ids": a[:1]})
        assert alone.is_error and "Give 2 to 500 different paper IDs, not 1" in alone.content[0].text
