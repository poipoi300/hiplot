"""Generate the synthetic benchmark experiments and render them to standalone HTML.

Each size mixes the column kinds HiPlot treats differently: linear numeric,
log-scale numeric (spanning several orders of magnitude so type inference picks
a log axis), categorical strings, and a sparse numeric column with NaN and inf
values that exercises the outlier band. Generation is seeded, so every phase of
the benchmark renders byte-identical experiments.

Usage:
    uv run python bench/make_experiments.py --out <dir> [--sizes 5000x20 ...]
"""

import argparse
import math
import random
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import hiplot as hip

DEFAULT_SIZES = ("5000x20", "20000x30", "50000x50")
CATEGORY_POOLS = (
    ("adam", "sgd", "rmsprop", "adagrad"),
    ("relu", "gelu", "tanh", "silu", "elu", "mish"),
    ("small", "base", "large"),
    tuple(f"dataset_{index:02d}" for index in range(12)),
)


@dataclass(frozen=True)
class ExperimentSize:
    """Row and column counts of one synthetic experiment."""

    rows: int
    columns: int

    @property
    def label(self) -> str:
        return f"{self.rows // 1000}k x {self.columns}"

    @property
    def file_stem(self) -> str:
        return f"bench-{self.rows}x{self.columns}"

    @staticmethod
    def parse(text: str) -> "ExperimentSize":
        rows, columns = text.lower().split("x")
        return ExperimentSize(rows=int(rows), columns=int(columns))


def column_kind(index: int) -> str:
    """Kind of the column at `index`: a fixed rotation so every size has every kind."""
    if index % 10 == 9:
        return "sparse"
    return ("numeric", "numeric", "log", "categorical")[index % 4]


def generate_rows(size: ExperimentSize, seed: int) -> Iterator[dict[str, float | str]]:
    """Yield `size.rows` rows of `size.columns` values each, deterministically."""
    rng = random.Random(seed)
    kinds = [column_kind(index) for index in range(size.columns)]
    names = [f"{kind}_{index:02d}" for index, kind in enumerate(kinds)]
    for _ in range(size.rows):
        row: dict[str, float | str] = {}
        latent = rng.gauss(0.0, 1.0)
        for index, (name, kind) in enumerate(zip(names, kinds, strict=True)):
            match kind:
                case "numeric":
                    row[name] = round(latent * (index + 1) + rng.gauss(0.0, 2.0), 4)
                case "log":
                    row[name] = float(f"{10 ** rng.uniform(-4.0, 3.0):.5g}")
                case "categorical":
                    pool = CATEGORY_POOLS[index % len(CATEGORY_POOLS)]
                    row[name] = pool[rng.randrange(len(pool))]
                case "sparse":
                    draw = rng.random()
                    if draw < 0.02:
                        row[name] = math.inf
                    elif draw < 0.05:
                        row[name] = math.nan
                    else:
                        row[name] = round(rng.uniform(0.0, 1.0), 4)
        yield row


def write_experiment(size: ExperimentSize, out_dir: Path, seed: int) -> Path:
    """Render one experiment to `<out_dir>/<file_stem>.html` and return the path."""
    experiment = hip.Experiment.from_iterable(generate_rows(size, seed))
    path = out_dir / f"{size.file_stem}.html"
    experiment.to_html(path)
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True, help="Directory the HTML files are written to")
    parser.add_argument("--sizes", nargs="+", default=list(DEFAULT_SIZES), help="ROWSxCOLUMNS, e.g. 5000x20")
    parser.add_argument("--seed", type=int, default=20261106)
    args = parser.parse_args(argv)
    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    for text in args.sizes:
        path = write_experiment(ExperimentSize.parse(text), out_dir, args.seed)
        print(f"{path}  {path.stat().st_size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
