"""Fetchers that read experiments from inline JSON, training logs, and user modules."""

import json
from pathlib import Path

import pytest

from .. import experiment as exp
from ..fetchers import (
    InlineJsonFetcher,
    _parse_namespace_keywords,
    get_fetcher,
    load_fairseq,
    load_json,
    load_wav2letter,
)


def test_inline_json_uri_is_an_experiment_and_its_length_ends_at_the_array() -> None:
    fetcher = InlineJsonFetcher()
    uri = 'json://[{"lr": 0.1}, {"lr": 0.2}]'
    assert [dp.values["lr"] for dp in fetcher(uri).datapoints] == [0.1, 0.2]
    assert fetcher.get_uri_length(uri + " trailing") == len(uri)
    with pytest.raises(exp.ExperimentFetcherDoesntApply):
        fetcher("demo")
    with pytest.raises(exp.ExperimentFetcherDoesntApply):
        fetcher.get_uri_length("demo")


def test_nevergrad_json_flattens_parameters_and_scores(tmp_path: Path) -> None:
    path = tmp_path / "ng.json"
    jobs = [{"job_id": 7, "kwargs": {"lr": 0.1}, "results": {"scores": {"loss": 0.5}}}]
    path.write_text(json.dumps(jobs), encoding="utf-8")
    (datapoint,) = load_json(str(path)).datapoints
    assert datapoint.values == {"id": 7, "lr": "0.1", "loss": 0.5}
    with pytest.raises(exp.ExperimentFetcherDoesntApply):
        load_json("not-json.txt")


FAIRSEQ_LOG = """\
2020-03-08 16:48:16 | INFO | Namespace(arch='transformer', lr=[0.25])
| epoch 001 | loss 8.413 | wall abc
| epoch 001 | valid on 'valid' subset | loss 7.599
valid | {"epoch": 2, "valid_loss": "0.723"}
| epoch 002 | lr 0.1
"""


def test_fairseq_log_gives_one_chained_datapoint_per_epoch(tmp_path: Path) -> None:
    (tmp_path / "train.log").write_text(FAIRSEQ_LOG, encoding="utf-8")
    xp = load_fairseq(f"fairseq://{tmp_path}")
    first, second = xp.datapoints
    assert first.values == {
        "arch": "transformer",
        "lr": [0.25],
        "epoch": 1,
        "loss": 8.413,
        "wall": "abc",
        "valid_loss": 7.599,
    }
    assert second.values["valid_loss"] == "0.723"
    assert second.values["lr"] == 0.1
    assert second.from_uid == first.uid


def test_fairseq_reads_a_log_file_given_directly(tmp_path: Path) -> None:
    log = tmp_path / "run.txt"
    log.write_text("| epoch 003 | loss 1.0\n", encoding="utf-8")
    assert load_fairseq(f"fairseq://{log}").datapoints[0].values == {"epoch": 3, "loss": 1.0}


def test_fairseq_rejects_other_uris_and_directories_without_logs(tmp_path: Path) -> None:
    with pytest.raises(exp.ExperimentFetcherDoesntApply):
        load_fairseq("demo")
    with pytest.raises(exp.ExperimentFetcherDoesntApply, match="No log file"):
        load_fairseq(f"fairseq://{tmp_path}")


def test_namespace_lines_must_be_calls() -> None:
    with pytest.raises(ValueError, match="Expected a Namespace"):
        _parse_namespace_keywords("Namespace(a=1)[0]")


def test_wav2letter_perf_files_become_a_chain_of_checkpoints(tmp_path: Path) -> None:
    run = tmp_path / "run42"
    run.mkdir()
    (run / "001_perf").write_text("# date\tloss\twer\n2019-09-30\t1.5\tabc\n\n", encoding="utf-8")
    (run / "002_perf").write_text("# date\tloss\twer\n2019-10-01\t1.2\t9\n", encoding="utf-8")
    first, second = load_wav2letter(f"w2l://{run}").datapoints
    assert first.values == {"perf_date": "2019-09-30", "perf_loss": 1.5, "perf_wer": "abc"}
    assert (first.uid, second.uid, second.from_uid) == ("run42_0", "run42_1", "run42_0")
    with pytest.raises(exp.ExperimentFetcherDoesntApply):
        load_wav2letter("demo")


def test_fetchers_load_from_installed_modules_and_from_modules_in_the_working_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert get_fetcher("hiplot.fetchers.load_demo").__name__ == "load_demo"
    monkeypatch.chdir(tmp_path)
    (tmp_path / "my_fetchers.py").write_text(
        "import hiplot\n\ndef load(uri):\n    return hiplot.Experiment.from_iterable([{'uri': uri}])\n",
        encoding="utf-8",
    )
    assert get_fetcher("my_fetchers.load")("x").datapoints[0].values == {"uri": "x"}
    with pytest.raises(ModuleNotFoundError):
        get_fetcher("no_such_package.sub.load")
