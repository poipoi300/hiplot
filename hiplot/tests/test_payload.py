# Copyright (c) Facebook, Inc. and its affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
"""The experiment payload the frontend receives, and how pages embed it."""

import json
import math
import re

import pytest

import hiplot as hip
from hiplot.compress import compress, compress_columnar, encode_value
from hiplot.render import DATA_MARKER, json_for_script_element, make_experiment_standalone_page

DATA_BLOCK = re.compile(r'<script type="application/json" id="(hiplot_data_[0-9a-f]+)">(.*?)</script>', re.S)


def sample() -> hip.Experiment:
    return hip.Experiment(
        datapoints=[
            hip.Datapoint(uid="a", values={"loss": 0.5, "opt": "adam"}),
            hip.Datapoint(uid="b", from_uid="a", values={"loss": math.inf, "lr": None}),
            hip.Datapoint(uid="c", values={"loss": math.nan, "opt": "</script><!--"}),
        ]
    )


def test_non_finite_floats_become_json_objects() -> None:
    assert encode_value(math.inf) == {"$f": "inf"}
    assert encode_value(-math.inf) == {"$f": "-inf"}
    assert encode_value(math.nan) == {"$f": "nan"}
    assert encode_value("inf") == "inf"
    assert encode_value(3) == 3


def test_columnar_payload_lists_one_array_per_column_in_first_seen_order() -> None:
    columnar = compress_columnar(sample().datapoints)
    assert columnar["uid"] == ["a", "b", "c"]
    assert columnar["from_uid"] == [None, "a", None]
    assert list(columnar["columns"]) == ["loss", "opt", "lr"]
    assert columnar["columns"]["loss"] == [0.5, {"$f": "inf"}, {"$f": "nan"}]


def test_columnar_payload_keeps_absent_values_distinct_from_none() -> None:
    columnar = compress_columnar(sample().datapoints)
    assert columnar["columns"]["lr"] == [None, None, None]
    assert columnar["missing"] == {"opt": [1], "lr": [0, 2]}


def test_payload_is_strict_json() -> None:
    json.dumps(sample()._payload(), allow_nan=False)


def test_row_major_compression_keeps_its_format() -> None:
    compressed = compress(sample().datapoints)
    assert compressed["columns"] == ["loss", "opt", "lr"]
    assert compressed["rows"][0] == ["a", None, 0.5, "adam", None]


def test_legacy_asdict_is_unchanged() -> None:
    data = sample()._asdict()
    assert data["datapoints"][0] == {"uid": "a", "values": {"loss": 0.5, "opt": "adam"}, "from_uid": None}
    exp = sample()
    exp._compress = True
    assert "datapoints_compressed" in exp._asdict()


def test_script_json_cannot_close_its_element() -> None:
    text = json_for_script_element({"x": "</script><!--"})
    assert "<" not in text
    assert json.loads(text) == {"x": "</script><!--"}


def test_standalone_page_embeds_options_as_a_json_data_block() -> None:
    page = make_experiment_standalone_page({"experiment": sample()._payload()})
    match = DATA_BLOCK.search(page)
    assert match is not None
    data_id, data = match.groups()
    options = json.loads(data)
    assert options["dataProviderName"] == "none"
    assert options["experiment"]["datapoints_columnar"]["uid"] == ["a", "b", "c"]
    assert f"document.getElementById({json.dumps(data_id)})" in page
    assert DATA_MARKER not in page
    assert "eval(" not in page


def test_to_html_inlines_the_bundle_and_never_parses_the_data_as_html() -> None:
    html = sample().to_html()
    match = DATA_BLOCK.search(html)
    assert match is not None
    assert json.loads(match.group(2))["experiment"]["datapoints_columnar"]["columns"]["opt"][2] == "</script><!--"
    assert 'src="static/built/hiplot.bundle.js"' not in html


def test_options_that_json_cannot_represent_fail_loudly() -> None:
    with pytest.raises(ValueError, match="JSON compliant"):
        make_experiment_standalone_page({"bad": math.inf})
