# Copyright (c) Facebook, Inc. and its affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
"""Compact encodings of an experiment's datapoints for the frontend.

`src/lib/compress.ts` decodes both formats; the two sides change together.
"""

import math
from collections.abc import Iterable, Sequence
from typing import Any

from .experiment import Datapoint

RESERVED_COLUMNS = frozenset(("uid", "from_uid"))

#: Key of the JSON object standing for a non-finite float, which JSON cannot represent.
NON_FINITE_KEY = "$f"


def _build_columns_list(datapoints: Iterable[Datapoint]) -> list[str]:
    """Value columns in first-seen order, so the output is deterministic."""
    columns: dict[str, None] = {}
    for dp in datapoints:
        columns.update(dict.fromkeys(dp.values))
    return [column for column in columns if column not in RESERVED_COLUMNS]


def compress(datapoints: list[Datapoint]) -> dict[str, Any]:
    """Row-major encoding: column names once, then one array per row."""
    columns = _build_columns_list(datapoints)
    rows = [[dp.uid, dp.from_uid, *(dp.values.get(c) for c in columns)] for dp in datapoints]
    return {"columns": columns, "rows": rows}


def encode_value(value: Any) -> Any:
    """A JSON-safe value: non-finite floats become {"$f": "inf" | "-inf" | "nan"}."""
    if isinstance(value, float) and not math.isfinite(value):
        return {NON_FINITE_KEY: "nan" if math.isnan(value) else ("inf" if value > 0 else "-inf")}
    return value


def compress_columnar(datapoints: Sequence[Datapoint]) -> dict[str, Any]:
    """Column-major encoding, valid strict JSON.

    Each column is one array with a value per row, so column names are not
    repeated per row. A datapoint without a value for a column is listed in
    `missing` (its slot holds null), keeping "absent" distinct from None.
    """
    columns = _build_columns_list(datapoints)
    values: dict[str, list[Any]] = {}
    missing: dict[str, list[int]] = {}
    for column in columns:
        column_values: list[Any] = []
        column_missing: list[int] = []
        for index, dp in enumerate(datapoints):
            if column in dp.values:
                column_values.append(encode_value(dp.values[column]))
            else:
                column_values.append(None)
                column_missing.append(index)
        values[column] = column_values
        if column_missing:
            missing[column] = column_missing
    return {
        "uid": [dp.uid for dp in datapoints],
        "from_uid": [dp.from_uid for dp in datapoints],
        "columns": values,
        "missing": missing,
    }
