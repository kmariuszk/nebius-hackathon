import pytest

from harness import models, settings, toolsets


def test_models_point_at_token_factory(monkeypatch):
    monkeypatch.setenv("LIGHTNING_MODEL", "nvidia/other-model")
    lightning = models.lightning()
    assert lightning.model == "openai/nvidia/other-model"
    assert lightning._additional_args["api_base"] == models.TOKEN_FACTORY_URL
    assert models.super_vl().model == "openai/" + models.SUPER_VL


def test_missing_key_says_how_to_fix_it(monkeypatch):
    monkeypatch.delenv("TF_API_KEY")
    with pytest.raises(settings.MissingSetting, match="TF_API_KEY is not set. Copy .env.example"):
        models.lightning()


def test_toolsets_filter_tools_and_send_the_board_token(monkeypatch):
    monkeypatch.setenv("BOARD_TOKEN", "board-token")
    monkeypatch.setenv("CANVAS_MCP_URL", "http://board/mcp/canvas/b_1")
    canvas = toolsets.canvas("add_papers")
    params = canvas._connection_params
    assert params.url == "http://board/mcp/canvas/b_1"
    assert params.headers == {"Authorization": "Bearer board-token"}
    assert canvas.tool_filter == ["add_papers"]
    assert toolsets.papers().tool_filter is None


def test_canvas_needs_its_url(monkeypatch):
    monkeypatch.delenv("CANVAS_MCP_URL", raising=False)
    with pytest.raises(settings.MissingSetting, match="CANVAS_MCP_URL"):
        toolsets.canvas()
