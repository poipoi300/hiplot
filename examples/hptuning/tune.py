# /// script
# requires-python = ">=3.12"
# dependencies = ["torch>=2.7", "optuna>=4.0", "scikit-learn>=1.5", "polars>=1.0", "hiplot-mm"]
#
# [tool.uv.sources]
# torch = [{ index = "pytorch-cu128", marker = "sys_platform != 'darwin'" }]
# hiplot-mm = { path = "../..", editable = true }
#
# [[tool.uv.index]]
# name = "pytorch-cu128"
# url = "https://download.pytorch.org/whl/cu128"
# explicit = true
# ///
"""A real hyperparameter search, rendered with HiPlot.

Trains thousands of small MLPs on the UCI handwritten digits (see search.py)
and writes every trial to a standalone HiPlot page. With --from-parquet, the
page is rendered again from the trials a previous run wrote with --parquet,
without training; that path imports neither torch nor optuna.

Recorded per trial: the hyperparameters, the final train and validation
loss, the best validation loss and its epoch, the validation accuracy, the
parameter count, a divergence flag, and the wall time the model occupied the
GPU (the round's time scaled by the model's share of the round's steps).

Usage:
    uv run examples/hptuning/tune.py --out hptuning.html [--trials 10000] [--parquet hptuning.parquet]
    uv run examples/hptuning/tune.py --out hptuning.html --from-parquet hptuning.parquet
"""

import argparse
from collections.abc import Sequence
from pathlib import Path

import polars as pl

import hiplot as hip


def write_page(experiment: hip.Experiment, out: Path) -> None:
    """Writes the trials as a HiPlot page: log axes for rates and losses, colored by accuracy.

    The uid is the trial's index in the search, shown as a number next to the
    accuracy: how many trials it took to get close to the best.
    """
    for log_column in ("lr", "weight_decay", "val_loss", "best_val_loss", "train_loss"):
        experiment.parameters_definition[log_column].type = hip.ValueType.NUMERIC_LOG
    experiment.parameters_definition["uid"].type = hip.ValueType.NUMERIC
    experiment.colorby = "val_accuracy"
    experiment.display_data(hip.Displays.PARALLEL_PLOT).update(
        {
            "order": [
                "lr",
                "optimizer",
                "weight_decay",
                "batch_size",
                "width",
                "depth",
                "activation",
                "dropout",
                "label_smoothing",
                "epochs",
                "best_epoch",
                "train_loss",
                "val_loss",
                "val_accuracy",
                "uid",
                "diverged",
            ],
            "hide": ["params", "wall_time_s", "best_val_loss"],
        }
    )
    experiment.display_data(hip.Displays.XY).update({"axis_x": "lr", "axis_y": "val_accuracy"})
    experiment.display_data(hip.Displays.TABLE).update({"order_by": [["val_accuracy", "desc"]]})
    out.parent.mkdir(parents=True, exist_ok=True)
    experiment.to_html(out)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True, help="HiPlot page to write")
    parser.add_argument("--from-parquet", type=Path, help="render the trials of this Parquet file instead of searching")
    parser.add_argument("--parquet", type=Path, help="also write the trials as Parquet")
    parser.add_argument("--trials", type=int, default=10_000)
    parser.add_argument("--round", type=int, default=1000, help="trials proposed at once")
    parser.add_argument("--group", type=int, default=250, help="trials trained at once")
    parser.add_argument("--random-trials", type=int, default=2000, help="random trials before TPE")
    parser.add_argument("--window", type=int, default=1000, help="recent trials TPE learns from")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args(argv)
    if args.from_parquet is not None:
        if args.parquet is not None:
            parser.error("--parquet writes the trials of a search, --from-parquet reads them back: pass one")
        experiment = hip.Experiment.from_iterable(pl.read_parquet(args.from_parquet).to_dicts())
        write_page(experiment, args.out)
        print(f"wrote {args.out} ({len(experiment.datapoints)} trials from {args.from_parquet})")
        return 0

    # Imported here so that rendering from a CSV needs neither torch nor optuna.
    from search import SearchSettings, run_search

    rows = run_search(
        SearchSettings(
            trials=args.trials,
            round=args.round,
            group=args.group,
            random_trials=args.random_trials,
            window=args.window,
            seed=args.seed,
        )
    )
    # Trials are written before the page, so a failed render never loses a search.
    if args.parquet is not None:
        args.parquet.parent.mkdir(parents=True, exist_ok=True)
        pl.DataFrame(rows).write_parquet(args.parquet)
        print(f"wrote {args.parquet}")
    experiment = hip.Experiment.from_iterable(rows)
    write_page(experiment, args.out)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
