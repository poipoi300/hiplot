# Copyright (c) Facebook, Inc. and its affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

from collections.abc import Iterable
from typing import Any

from .experiment import Datapoint

RESERVED_COLUMNS = frozenset(("uid", "from_uid"))


def _build_columns_list(datapoints: Iterable[Datapoint]) -> list[str]:
    """Value columns in first-seen order, so the output is deterministic."""
    columns: dict[str, None] = {}
    for dp in datapoints:
        columns.update(dict.fromkeys(dp.values))
    return [column for column in columns if column not in RESERVED_COLUMNS]


def compress(datapoints: list[Datapoint]) -> dict[str, Any]:
    columns = _build_columns_list(datapoints)
    rows = [[dp.uid, dp.from_uid, *(dp.values.get(c) for c in columns)] for dp in datapoints]
    return {"columns": columns, "rows": rows}
