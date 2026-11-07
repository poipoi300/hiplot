"""The web server routes and the command-line entry points."""

import sys

import pytest

from ..fetchers import get_fetchers
from ..render import hiplot_render_main
from ..server import create_app


def test_server_serves_the_interface_and_experiments_by_uri() -> None:
    client = create_app(get_fetchers([])).test_client()
    assert b"<html" in client.get("/").data
    loaded = client.get("/data?uri=demo").get_json()
    assert loaded["query"] == "demo"
    assert loaded["experiment"]["datapoints_columnar"]["uid"]
    missing = client.get("/data?uri=no-such-experiment").get_json()
    assert missing["error"].startswith("No fetcher found")


@pytest.mark.parametrize(("output_format", "expected_start"), [("csv", b"uid,"), ("html", b"<!DOCTYPE html>")])
def test_render_command_writes_the_experiment_to_stdout(
    output_format: str,
    expected_start: bytes,
    monkeypatch: pytest.MonkeyPatch,
    capsysbinary: pytest.CaptureFixture[bytes],
) -> None:
    monkeypatch.setattr(sys, "argv", ["hiplot-render", "demo", "--format", output_format])
    assert hiplot_render_main() == 0
    assert capsysbinary.readouterr().out.lstrip().startswith(expected_start)
