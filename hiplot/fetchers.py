# Copyright (c) Facebook, Inc. and its affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

import ast
import csv
import importlib
import importlib.util
import itertools
import json
import random
import re
import typing as tp
from pathlib import Path

from . import experiment as hip
from .fetchers_demo import README_DEMOS


class NoFetcherFound(Exception):
    def __init__(self, uri: str):
        super().__init__(f"Unable to fetch an HiPlot experiment from '{uri}'")


def load_xp_with_fetchers_partial(fetchers: list[hip.ExperimentFetcher], uri: str) -> tuple[hip.Experiment, int]:
    """
    Attempts to parse an uri.
    Returns a corresponding experiment, and position in uri following the last used character.

    Example:
    /path1
    /path2
    Returns the Experiment for `/path1` and position the substring `\n/path2`
    """
    eol = uri.find("\n")
    if eol == -1:
        eol = len(uri)
    for f in fetchers:
        try:
            endoffetcher = eol
            get_uri_length: tp.Callable[[str], int] | None = getattr(f, "get_uri_length", None)
            if get_uri_length is not None:
                endoffetcher = get_uri_length(uri)
            return f(uri[:endoffetcher]), endoffetcher
        except hip.ExperimentFetcherDoesntApply:
            continue
    raise NoFetcherFound(uri)


def load_xps_with_fetchers(fetchers: list[hip.ExperimentFetcher], uri: str) -> list[hip.Experiment]:
    uri = uri.lstrip()
    xps: list[hip.Experiment] = []
    while uri:
        xp, endfetcher = load_xp_with_fetchers_partial(fetchers, uri)
        uri = uri[endfetcher:].lstrip()
        xps.append(xp)
    assert xps, uri  # If URI is empty, we should raise in `load_xp_with_fetchers_partial`
    return xps


def load_xp_with_fetchers(fetchers: list[hip.ExperimentFetcher], uri: str) -> hip.Experiment:
    xps = load_xps_with_fetchers(fetchers, uri)
    return hip.Experiment.merge({f"{i}": xp for i, xp in enumerate(xps)}) if len(xps) > 1 else xps[0]


class MultipleFetcher:
    MULTI_PREFIX = "multi://"

    def __init__(self, fetchers: list[hip.ExperimentFetcher]) -> None:
        self.fetchers: list[hip.ExperimentFetcher] = [*fetchers, self]

    def __call__(self, uri: str) -> hip.Experiment:
        if not uri.startswith(self.MULTI_PREFIX):
            raise hip.ExperimentFetcherDoesntApply()
        defs = json.loads(uri[len(self.MULTI_PREFIX) :])
        if isinstance(defs, list):
            return hip.Experiment.merge({v: load_xp_with_fetchers(self.fetchers, v) for v in defs})
        return hip.Experiment.merge({k: load_xp_with_fetchers(self.fetchers, v) for k, v in defs.items()})

    def get_uri_length(self, uri: str) -> int:
        """
        Returns the end position of the multi block
        """
        if not uri.startswith(self.MULTI_PREFIX):
            raise hip.ExperimentFetcherDoesntApply()
        decoder = json.JSONDecoder()
        _, current_read_offset = decoder.raw_decode(uri[len(self.MULTI_PREFIX) :])
        return len(self.MULTI_PREFIX) + current_read_offset


class InlineJsonFetcher:
    URI_PREFIX = "json://"

    def __call__(self, uri: str) -> hip.Experiment:
        if not uri.startswith(self.URI_PREFIX):
            raise hip.ExperimentFetcherDoesntApply()
        exp_rows = json.loads(uri[len(self.URI_PREFIX) :])
        assert isinstance(exp_rows, list)
        return hip.Experiment.from_iterable(exp_rows)

    def get_uri_length(self, uri: str) -> int:
        """
        Returns the end position of the multi block
        """
        if not uri.startswith(self.URI_PREFIX):
            raise hip.ExperimentFetcherDoesntApply()
        decoder = json.JSONDecoder()
        _, current_read_offset = decoder.raw_decode(uri[len(self.URI_PREFIX) :])
        return len(self.URI_PREFIX) + current_read_offset


def load_demo(uri: str) -> hip.Experiment:
    if uri in README_DEMOS:
        # Keep demo data deterministic across page reloads/tests while preserving
        # the caller's RNG state outside this function.
        random_state = random.getstate()
        try:
            random.seed(f"hiplot-demo:{uri}")
            return README_DEMOS[uri]()
        finally:
            random.setstate(random_state)
    raise hip.ExperimentFetcherDoesntApply()


def load_csv(uri: str) -> hip.Experiment:
    if not uri.endswith(".csv"):
        raise hip.ExperimentFetcherDoesntApply(f"Not a CSV file: {uri}")
    try:
        with Path(uri).open(newline="", encoding="utf-8") as csvfile:
            return hip.Experiment.from_iterable(csv.DictReader(csvfile))
    except FileNotFoundError as error:
        raise hip.ExperimentFetcherDoesntApply(f"No such file: {uri}") from error


def load_json(uri: str) -> hip.Experiment:
    if not uri.endswith(".json"):
        raise hip.ExperimentFetcherDoesntApply(f"Not a JSON file: {uri}")
    dat = json.loads(Path(uri).read_text(encoding="utf-8"))
    if "job_id" in dat[0] and "kwargs" in dat[0] and "results" in dat[0]:
        # Nevergrad JSON
        return hip.Experiment.from_iterable(
            [
                {
                    "id": j["job_id"],
                    **{param_name: str(param_val) for param_name, param_val in j["kwargs"].items()},
                    **j["results"]["scores"],
                }
                for j in dat
            ]
        )
    return hip.Experiment.from_iterable(dat)


def _load_fairseq_metrics_inline(line: str) -> dict[str, tp.Any]:
    line = line.removeprefix("| epoch ")
    epoch = int(line[:3])
    values: dict[str, tp.Any] = {"epoch": epoch}
    # | epoch 002 | loss 8.413 | ...
    # | epoch 002 | valid on 'valid' subset | loss 7.599 | nll_loss 7.599 | ...
    parts = line.split("|")[1:]
    prefix = ""
    for p in parts:
        p = p.strip()
        match_ds = re.match(r"valid on '([a-zA-Z0-9]*)' subset", p)
        if match_ds is not None:
            prefix = match_ds.group(1) + "_"
            continue
        key = prefix + p[::-1].split(" ", 1)[1][::-1].strip()
        value = p[::-1].split(" ", 1)[0][::-1].strip()
        try:
            values[key] = float(value)
        except ValueError:
            values[key] = value
    return values


def _parse_namespace_keywords(line: str) -> dict[str, tp.Any]:
    call = ast.parse(line, mode="eval").body
    if not isinstance(call, ast.Call):
        raise ValueError(f"Expected a Namespace(...) call, got: {line[:80]}")
    return {kw.arg: ast.literal_eval(kw.value) for kw in call.keywords if kw.arg is not None}


def load_fairseq(uri: str) -> hip.Experiment:
    PREFIX = "fairseq://"
    if not uri.startswith(PREFIX):
        raise hip.ExperimentFetcherDoesntApply()
    uri = uri[len(PREFIX) :]
    train_log = Path(uri)
    if train_log.is_dir():
        found = False
        try_files = [
            *(train_log / f for f in ["train.log", "process.out", "process_0.out"]),
            *train_log.glob("*.log"),
            *(train_log / "slurm_logs").glob("*.log"),
        ]
        for try_log_file in try_files:
            if try_log_file.is_file():
                found = True
                train_log = try_log_file
                break
        if not found:
            raise hip.ExperimentFetcherDoesntApply("No log file found")
    lines = train_log.read_text(encoding="utf-8").split("\n")

    datapoints: list[dict[str, tp.Any]] = []
    params: dict[str, tp.Any] = {}
    logs_prefix_re = r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| [A-Z]* \| )"
    for raw_line in lines:
        # Strip log prefix, eg "2020-03-08 16:48:16 | INFO | "
        m = re.match(logs_prefix_re, raw_line)
        line = raw_line if m is None else raw_line[m.span()[1] :]
        if line.startswith("Namespace("):
            # Format: Namespace(activation_dropout=0.1, activation_fn='relu', ...). Evaluating it as
            # `dict(...)` would run user input, so parse the keywords as literals instead (a too
            # complex string can still exhaust the parser's stack depth).
            params = _parse_namespace_keywords(line)
            continue
        # Results in JSON format
        # valid | {"epoch": 33, "valid_loss": "0.723", "valid_ppl": "1.65", ...}
        if line.startswith("valid | {"):
            json_string = line.split("|", 1)[-1].lstrip()
            valid_metrics = json.loads(json_string)
            datapoints.append(valid_metrics)
        # For older version of fairseq
        if line.startswith("| epoch "):
            values = _load_fairseq_metrics_inline(line)
            if datapoints and datapoints[-1]["epoch"] == values["epoch"]:
                datapoints[-1].update(values)
            else:
                datapoints.append(values)
    datapoints = [
        {
            **params,
            **values,  # overrides 'learning rate' for instance
        }
        for values in datapoints
    ]
    datapoints.sort(key=lambda d: float(d["epoch"]))
    xp = hip.Experiment.from_iterable(datapoints)
    for dp, next_dp in itertools.pairwise(xp.datapoints):
        next_dp.from_uid = dp.uid
    return xp


class Wav2letterLoader:
    def _parse_metrics(self, file: Path) -> list[dict[str, tp.Any]]:
        # 001_perf:
        """
        # date\tkey1\tkey2...
        2019-09-30\tval1\tval2...
        """
        PERF_PREFIX = "perf_"
        lines = file.read_text(encoding="utf-8").split("\n")
        metrics: list[dict[str, tp.Any]] = []
        for line in lines[1:]:
            if line == "":
                continue
            epoch_metrics: dict[str, tp.Any] = {}
            for name, val in zip(lines[0].split()[1:], line.split(), strict=False):
                try:
                    epoch_metrics[PERF_PREFIX + name] = float(val)
                except ValueError:
                    epoch_metrics[PERF_PREFIX + name] = val
            metrics.append(epoch_metrics)
        return metrics

    def __call__(self, uri: str) -> hip.Experiment:
        PREFIX = "w2l://"
        if not uri.startswith(PREFIX):
            raise hip.ExperimentFetcherDoesntApply()
        uri = uri[len(PREFIX) :]
        perfs = sorted(Path(uri).glob("*_perf"))

        prev_ckpt_name: str | None = None
        xp = hip.Experiment()
        for p in perfs:
            mtrics = self._parse_metrics(p)
            for m in mtrics:
                ckpt_name = uri[-5:] + "_" + str(len(xp.datapoints))
                xp.datapoints.append(hip.Datapoint(uid=ckpt_name, from_uid=prev_ckpt_name, values=m))
                prev_ckpt_name = ckpt_name
        return xp


load_wav2letter = Wav2letterLoader()


def _get_module_by_name_in_cwd(name: str) -> tp.Any:
    spec = importlib.util.spec_from_file_location(name, str(Path.cwd() / f"{name}.py"))
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def get_fetcher(fetcher_spec: str) -> hip.ExperimentFetcher:
    parts = fetcher_spec.split(".")
    try:
        module = importlib.import_module(".".join(parts[:-1]))
    except ModuleNotFoundError:
        if len(parts) != 2:
            raise
        module = _get_module_by_name_in_cwd(parts[0])
    if module is None:
        raise RuntimeError(f"Unable to create fetcher '{fetcher_spec}'")

    fetcher: hip.ExperimentFetcher = getattr(module, parts[-1])
    return fetcher


def get_fetchers(add_fetchers: list[str]) -> list[hip.ExperimentFetcher]:
    xp_fetchers: list[hip.ExperimentFetcher] = [
        load_demo,
        load_csv,
        load_json,
        load_fairseq,
        load_wav2letter,
        InlineJsonFetcher(),
    ]
    xp_fetchers.extend(get_fetcher(fetcher_spec) for fetcher_spec in add_fetchers)
    xp_fetchers.append(MultipleFetcher(xp_fetchers))
    return xp_fetchers
