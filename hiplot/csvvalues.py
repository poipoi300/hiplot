"""Reads the numbers out of CSV cells, which the csv module leaves as text.

A column is numeric when every one of its cells spells a number: decimal or
exponent notation, ``inf``/``infinity``/``nan`` in any case with an optional
sign, or a missing value: blank, or ``na``/``n/a``/``null``/``none`` in any
case. At least one cell must be finite. The
grammar is the one the frontend applies to text cells (``src/lib/d3_scales.ts``),
so both sides agree on which columns are numeric.
"""

import math
import re
import typing as tp
from collections.abc import Iterable

_FINITE = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
_INTEGER = re.compile(r"[+-]?\d+")
_INFINITE = re.compile(r"([+-]?)(?:inf|infinity)", re.IGNORECASE)
_NAN = re.compile(r"[+-]?nan", re.IGNORECASE)
_MISSING = re.compile(r"na|n/a|null|none", re.IGNORECASE)

#: Columns that identify rows and are never read as numbers.
_IDENTIFIER_COLUMNS = frozenset({"uid", "from_uid"})


def parse_number(cell: str | None) -> int | float | None:
    """The number a CSV cell spells: an int, a float (inf and nan included), or None when missing.

    Blank cells, the missing-value spellings, and a short row's missing cells
    (None from ``csv.DictReader``) are missing.

    :raises ValueError: when the cell spells no number.
    """
    text = "" if cell is None else cell.strip()
    if _is_missing_spelling(text):
        return None
    if _INTEGER.fullmatch(text):
        return int(text)
    if _FINITE.fullmatch(text):
        return float(text)
    infinite = _INFINITE.fullmatch(text)
    if infinite is not None:
        return -math.inf if infinite.group(1) == "-" else math.inf
    if _NAN.fullmatch(text):
        return math.nan
    raise ValueError(f"Not a number: {cell!r}")


def _is_missing_spelling(text: str) -> bool:
    return text == "" or _MISSING.fullmatch(text) is not None


def _is_number_spelling(cell: str | None) -> bool:
    text = "" if cell is None else cell.strip()
    return (
        _is_missing_spelling(text)
        or _FINITE.fullmatch(text) is not None
        or _INFINITE.fullmatch(text) is not None
        or _NAN.fullmatch(text) is not None
    )


def _has_finite_number(cells: Iterable[str | None]) -> bool:
    return any(cell is not None and _FINITE.fullmatch(cell.strip()) is not None for cell in cells)


def typed_rows(rows: Iterable[dict[str, str | None]]) -> list[dict[str, tp.Any]]:
    """The rows of a ``csv.DictReader`` with the cells of each numeric column read as numbers.

    Columns holding any other text keep all of their cells as text, so a column
    never mixes numbers and strings.
    """
    table = list(rows)
    columns = {column for row in table for column in row} - _IDENTIFIER_COLUMNS
    numeric = {
        column
        for column in columns
        if all(_is_number_spelling(row[column]) for row in table if column in row)
        and _has_finite_number(row[column] for row in table if column in row)
    }
    return [
        {column: parse_number(cell) if column in numeric else cell for column, cell in row.items()} for row in table
    ]
