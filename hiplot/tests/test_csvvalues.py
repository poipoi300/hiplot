import io
import math

import pytest

import hiplot as hip

from ..csvvalues import parse_number, typed_rows

DIVERGED_TRIALS_CSV = """uid,from_uid,optimizer,val_accuracy,val_loss,note
0,,adam,0.95,0.12,
1,,sgd,nan,NaN,diverged
2,0,adam,0.5,inf,
3,,sgd,,-Infinity,
"""


def is_nan(value: object) -> bool:
    return isinstance(value, float) and math.isnan(value)


@pytest.mark.parametrize(
    ("cell", "number"),
    [("3", 3), ("-2.5", -2.5), (".5", 0.5), ("1e-3", 0.001), (" 7 ", 7), ("+4E2", 400.0)],
)
def test_finite_spellings_read_as_numbers(cell: str, number: float) -> None:
    assert parse_number(cell) == number


def test_integer_spellings_stay_integers() -> None:
    assert isinstance(parse_number("12"), int)
    assert isinstance(parse_number("12.0"), float)


@pytest.mark.parametrize(
    ("cell", "number"), [("inf", math.inf), ("+Infinity", math.inf), ("-INF", -math.inf), ("-inf", -math.inf)]
)
def test_infinity_spellings_keep_their_sign(cell: str, number: float) -> None:
    assert parse_number(cell) == number


@pytest.mark.parametrize("cell", ["nan", "NaN", "NAN", "-nan"])
def test_nan_spellings_read_as_nan(cell: str) -> None:
    value = parse_number(cell)
    assert isinstance(value, float)
    assert math.isnan(value)


@pytest.mark.parametrize("cell", ["", "  ", None])
def test_blank_cells_are_missing(cell: str | None) -> None:
    assert parse_number(cell) is None


@pytest.mark.parametrize("cell", ["abc", "0x1f", "1_000", "1,5", "nan1"])
def test_other_text_is_not_a_number(cell: str) -> None:
    with pytest.raises(ValueError, match="Not a number"):
        parse_number(cell)


def test_numeric_columns_with_nan_inf_and_blank_cells_hold_numbers() -> None:
    rows = typed_rows([{"acc": "0.9"}, {"acc": "nan"}, {"acc": "inf"}, {"acc": ""}])
    assert rows[0]["acc"] == 0.9
    assert is_nan(rows[1]["acc"])
    assert rows[2]["acc"] == math.inf
    assert rows[3]["acc"] is None


def test_columns_with_other_text_or_no_finite_number_keep_their_text() -> None:
    rows = typed_rows([{"opt": "adam", "flag": "nan", "uid": "1"}, {"opt": "3", "flag": "", "uid": "2"}])
    assert [row["opt"] for row in rows] == ["adam", "3"]
    assert [row["flag"] for row in rows] == ["nan", ""]
    assert [row["uid"] for row in rows] == ["1", "2"]


def test_from_csv_reads_diverged_trials_as_numbers() -> None:
    xp = hip.Experiment.from_csv(io.StringIO(DIVERGED_TRIALS_CSV))
    xp.validate()
    values = [dp.values for dp in xp.datapoints]
    assert [v["optimizer"] for v in values] == ["adam", "sgd", "adam", "sgd"]
    assert values[0]["val_accuracy"] == 0.95
    assert is_nan(values[1]["val_accuracy"])
    assert values[3]["val_accuracy"] is None
    assert [v["val_loss"] for v in values][2:] == [math.inf, -math.inf]
    assert [v["note"] for v in values] == ["", "diverged", "", ""]
    assert xp.datapoints[2].from_uid == "0"
    assert xp.datapoints[0].from_uid is None


def test_csv_round_trip_keeps_special_values_numeric() -> None:
    xp = hip.Experiment.from_iterable([{"uid": "a", "loss": math.nan}, {"uid": "b", "loss": 0.5}])
    buffer = io.StringIO()
    xp.to_csv(buffer)
    buffer.seek(0)
    losses = [dp.values["loss"] for dp in hip.Experiment.from_csv(buffer).datapoints]
    assert is_nan(losses[0])
    assert losses[1] == 0.5
