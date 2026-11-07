"""The web server routes and the command-line entry points."""

import runpy
import sys

import pytest

from .. import server
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


def test_data_without_a_uri_is_a_bad_request() -> None:
    response = create_app(get_fetchers([])).test_client().get("/data")
    assert response.status_code == 400
    assert response.get_json() == {"error": "Missing the uri query parameter"}


def test_running_the_package_starts_the_server(monkeypatch: pytest.MonkeyPatch) -> None:
    started: list[bool] = []

    def fake_main() -> int:
        started.append(True)
        return 0

    monkeypatch.setattr(server, "run_server_main", fake_main)
    with pytest.raises(SystemExit) as exit_info:
        runpy.run_module("hiplot", run_name="__main__")
    assert exit_info.value.code == 0
    assert started == [True]


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
