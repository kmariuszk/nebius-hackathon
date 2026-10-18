"""Embedding scores against a fake embeddings endpoint (no network).

The fake embeds a text as counts of a few topic words, so cosine similarity
behaves like meaning would and the expected order is easy to read.
"""

import json

import httpx
import pytest
from mcp import Client

from discovery.embeddings import QUERY_INSTRUCTION
from discovery.papers import Paper
from discovery.server import build_server
from discovery.service import Discovery
from discovery.sources import Skipped
from discovery.store import Store
from discovery.vectors import VectorStore

TOPICS = ["melanoma", "immunotherapy", "pd-1", "heart", "failure", "mice"]


def topic_vector(text: str) -> list[float]:
    words = text.lower().split()
    return [words.count(topic) + 0.01 for topic in TOPICS]


class FakeEmbeddings:
    def __init__(self) -> None:
        self.texts: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if not request.url.path.endswith("/embeddings"):
            return httpx.Response(404)
        assert request.headers["Authorization"] == "Bearer test-key"
        body = json.loads(request.content)
        self.texts += body["input"]
        data = [
            {"index": i, "embedding": topic_vector(text)} for i, text in enumerate(body["input"])
        ]
        return httpx.Response(200, json={"data": list(reversed(data)), "model": body["model"]})


def paper(pmid: str, title: str, abstract: str | None = None) -> Paper:
    return Paper(ids={"pmid": pmid}, title=title, abstract=abstract)


@pytest.fixture
def embeddings(monkeypatch):
    monkeypatch.setenv("TF_API_KEY", "test-key")
    for name in ("EMBED_API_KEY", "EMBED_BASE_URL", "EMBED_MODEL"):
        monkeypatch.delenv(name, raising=False)
    return FakeEmbeddings()


@pytest.fixture
def discovery(embeddings, tmp_path):
    store = Store()
    store.save(paper("1", "PD-1 blockade in melanoma", "immunotherapy for melanoma patients"))
    store.save(paper("2", "Melanoma immunotherapy response", "pd-1 immunotherapy in melanoma"))
    store.save(paper("3", "Heart failure outcomes", "heart failure in older adults"))
    store.save(paper("4", "Melanoma in mice"))
    client = httpx.AsyncClient(transport=httpx.MockTransport(embeddings))
    return Discovery(client, store, VectorStore(tmp_path / "vectors"))


async def test_ranks_candidates_by_similarity_to_question_and_seeds(discovery):
    result = await discovery.score_candidates(
        "melanoma immunotherapy", ["pmid:3", "pmid:4", "pmid:2"], seed_ids=["pmid:1"]
    )

    assert [p["paperId"] for p in result["top"]] == ["pmid:2", "pmid:4", "pmid:3"]
    best = result["top"][0]
    assert best["title"] == "Melanoma immunotherapy response"
    assert best["closestSeed"] == "pmid:1"
    assert best["score"] == pytest.approx((best["questionSimilarity"] + best["seedSimilarity"]) / 2)
    assert result["scored"] == 3
    assert result["skipped"] == []


async def test_without_seeds_scores_by_question_only(discovery):
    result = await discovery.score_candidates("heart failure", ["pmid:2", "pmid:3"], limit=1)

    assert [p["paperId"] for p in result["top"]] == ["pmid:3"]
    assert result["top"][0]["score"] == result["top"][0]["questionSimilarity"]
    assert result["top"][0]["seedSimilarity"] is None
    assert result["scored"] == 2


async def test_only_the_question_gets_the_query_instruction(discovery, embeddings):
    await discovery.score_candidates("melanoma immunotherapy", ["pmid:3"], seed_ids=["pmid:1"])

    assert embeddings.texts == [
        "PD-1 blockade in melanoma\n\nimmunotherapy for melanoma patients",
        "Heart failure outcomes\n\nheart failure in older adults",
        QUERY_INSTRUCTION + "melanoma immunotherapy",
    ]


async def test_reuses_stored_vectors_until_the_text_changes(discovery, embeddings):
    await discovery.score_candidates("melanoma", ["pmid:2", "pmid:4"])
    embeddings.texts.clear()

    await discovery.score_candidates("melanoma", ["pmid:2", "pmid:4"])
    assert embeddings.texts == [QUERY_INSTRUCTION + "melanoma"]

    # Paper 4 had no abstract; once a source supplies one, it is embedded again.
    discovery.store.save(paper("4", "Melanoma in mice", "melanoma grows in mice"))
    embeddings.texts.clear()
    await discovery.score_candidates("melanoma", ["pmid:2", "pmid:4"])
    assert embeddings.texts == ["Melanoma in mice\n\nmelanoma grows in mice", QUERY_INSTRUCTION + "melanoma"]


async def test_skips_unknown_candidates_and_drops_seeds_and_duplicates(discovery):
    # pmid:999 is not stored and the fake client has no PubMed, so it cannot be fetched.
    result = await discovery.score_candidates(
        "melanoma", ["pmid:1", "pmid:2", "pmid:2", "bogus", "pmid:999"], seed_ids=["pmid:1"]
    )

    assert [p["paperId"] for p in result["top"]] == ["pmid:2"]
    assert [note.split(":")[0] for note in result["skipped"]] == ["candidate bogus", "candidate pmid"]


async def test_without_a_key_scoring_says_which_variable_to_set(discovery, monkeypatch):
    monkeypatch.delenv("TF_API_KEY")
    with pytest.raises(Skipped, match="TF_API_KEY"):
        await discovery.score_candidates("melanoma", ["pmid:2"])


def test_vectors_are_per_model_and_survive_a_change_of_dimension(tmp_path):
    vectors = VectorStore(tmp_path / "vectors")
    vectors.put("model-a", {"pmid:1": ("text", [1.0, 0.0, 0.0])})
    assert set(vectors.get("model-a", {"pmid:1": "text"})) == {"pmid:1"}
    assert vectors.get("model-a", {"pmid:1": "other text"}) == {}
    assert vectors.get("model-b", {"pmid:1": "text"}) == {}

    vectors.put("model-b", {"doi:10.1/it's": ("text", [1.0, 0.0])})
    assert list(vectors.get("model-b", {"doi:10.1/it's": "text"})["doi:10.1/it's"]) == [1.0, 0.0]


async def test_score_candidates_over_mcp(discovery):
    async with Client(build_server(discovery)) as client:
        result = await client.call_tool(
            "score_candidates",
            {"question": "melanoma immunotherapy", "candidate_ids": ["pmid:2", "pmid:3"]},
        )
        assert not result.is_error
        assert result.structured_content["top"][0]["paperId"] == "pmid:2"
