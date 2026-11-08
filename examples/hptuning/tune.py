# /// script
# requires-python = ">=3.12"
# dependencies = ["torch>=2.7", "optuna>=4.0", "scikit-learn>=1.5", "hiplot-mm"]
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

Trains thousands of small MLPs on the UCI handwritten digits (8x8 images,
shipped with scikit-learn, so nothing is downloaded) and writes every trial
to a standalone HiPlot page. Optuna's TPE sampler proposes the trials in
rounds: random search first, then proposals from the trials seen so far, so
the distributions it leaves are shaped by the loss landscape.

Trials train on the GPU a few hundred at once, grouped by step count. Each
model's parameters are a slice of stacked tensors, and the hyperparameters
that change a model's shape or schedule become masks: hidden units beyond its width are zeroed, hidden
layers beyond its depth pass their input through, each model reads only the
first `batch_size` rows of the shared minibatch tensor, and a model stops
updating after its own number of steps. Activations, optimizers, dropout,
weight decay and label smoothing are applied per model.

Recorded per trial: the hyperparameters, the final train and validation
loss, the best validation loss and its epoch, the validation accuracy, the
parameter count, a divergence flag, and the wall time the model occupied the
GPU (the round's time scaled by the model's share of the round's steps).

Usage:
    uv run examples/hptuning/tune.py --out hptuning.html [--trials 10000]
"""

import argparse
import math
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import optuna
import torch
from sklearn.datasets import load_digits

import hiplot as hip

WIDTHS = (16, 32, 64, 128)
MAX_DEPTH = 3
BATCH_SIZES = (32, 64, 128, 256, 512)
OPTIMIZERS = ("sgd", "adam", "adamw")
ACTIVATIONS = ("relu", "gelu", "tanh", "silu")
CLASSES = 10
FEATURES = 64
#: A model whose training loss passes this, or is not finite, has diverged.
DIVERGED_LOSS = 10.0


@dataclass(frozen=True)
class Trial:
    """One set of hyperparameters proposed by the sampler."""

    number: int
    lr: float
    weight_decay: float
    width: int
    depth: int
    dropout: float
    batch_size: int
    optimizer: str
    activation: str
    epochs: int
    label_smoothing: float


def propose(trial: optuna.Trial, number: int) -> Trial:
    """The search space: log scales for the rates, categories for the shapes."""
    return Trial(
        number=number,
        lr=trial.suggest_float("lr", 1e-5, 3.0, log=True),
        weight_decay=trial.suggest_float("weight_decay", 1e-7, 1e-1, log=True),
        width=int(trial.suggest_categorical("width", WIDTHS)),
        depth=trial.suggest_int("depth", 1, MAX_DEPTH),
        dropout=trial.suggest_float("dropout", 0.0, 0.6),
        batch_size=int(trial.suggest_categorical("batch_size", BATCH_SIZES)),
        optimizer=str(trial.suggest_categorical("optimizer", OPTIMIZERS)),
        activation=str(trial.suggest_categorical("activation", ACTIVATIONS)),
        epochs=trial.suggest_int("epochs", 3, 30),
        label_smoothing=trial.suggest_float("label_smoothing", 0.0, 0.3),
    )


@dataclass(frozen=True)
class Digits:
    """The digits split once into training and validation rows, on the device."""

    x_train: torch.Tensor
    y_train: torch.Tensor
    x_val: torch.Tensor
    y_val: torch.Tensor


def load_data(device: torch.device, seed: int) -> Digits:
    digits = load_digits()
    x = torch.tensor(digits.data, dtype=torch.float32) / 16.0
    y = torch.tensor(digits.target, dtype=torch.long)
    order = torch.randperm(len(y), generator=torch.Generator().manual_seed(seed))
    split = int(0.8 * len(y))
    train, val = order[:split], order[split:]
    return Digits(x[train].to(device), y[train].to(device), x[val].to(device), y[val].to(device))


def column(values: Iterable[float], device: torch.device) -> torch.Tensor:
    """Per-model values as a [models, 1, 1] tensor that broadcasts over a batch."""
    return torch.tensor(list(values), dtype=torch.float32, device=device).view(-1, 1, 1)


def parameter_count(trial: Trial) -> int:
    width = trial.width
    hidden = (trial.depth - 1) * (width * width + width)
    return FEATURES * width + width + hidden + width * CLASSES + CLASSES


class Population:
    """The stacked parameters, optimizer state and masks of one round of models."""

    def __init__(self, trials: Sequence[Trial], device: torch.device, generator: torch.Generator):
        self.trials = trials
        self.device = device
        count = len(trials)
        width = max(t.width for t in trials)
        widths = torch.tensor([t.width for t in trials], device=device)
        #: [models, 1, width]: 1 for the hidden units a model has.
        self.units = (torch.arange(width, device=device) < widths.view(-1, 1)).float().unsqueeze(1)
        #: [models, hidden layers]: 1 where the hidden layer is one of the model's.
        self.layers = (
            torch.arange(MAX_DEPTH - 1, device=device)
            < torch.tensor([t.depth - 1 for t in trials], device=device).view(-1, 1)
        ).float()

        def init(fan_in: torch.Tensor, shape: tuple[int, ...]) -> torch.Tensor:
            weights = torch.randn((count, *shape), generator=generator, device=device)
            return (weights * torch.rsqrt(fan_in.float()).view(-1, 1, 1)).requires_grad_()

        # Fan-in is the model's own width, not the padded one.
        self.w_in = init(torch.full((count,), FEATURES, device=device), (FEATURES, width))
        self.w_hidden = [init(widths, (width, width)) for _ in range(MAX_DEPTH - 1)]
        self.w_out = init(widths, (width, CLASSES))
        self.b_in = torch.zeros((count, 1, width), device=device, requires_grad=True)
        self.b_hidden = [
            torch.zeros((count, 1, width), device=device, requires_grad=True) for _ in range(MAX_DEPTH - 1)
        ]
        self.b_out = torch.zeros((count, 1, CLASSES), device=device, requires_grad=True)
        self.parameters = [self.w_in, self.b_in, *self.w_hidden, *self.b_hidden, self.w_out, self.b_out]
        self.first_moment = [torch.zeros_like(p) for p in self.parameters]
        self.second_moment = [torch.zeros_like(p) for p in self.parameters]

        self.lr = column((t.lr for t in trials), device)
        self.weight_decay = column((t.weight_decay for t in trials), device)
        self.dropout = column((t.dropout for t in trials), device)
        self.smoothing = column((t.label_smoothing for t in trials), device).view(-1, 1)
        self.is_sgd = column((float(t.optimizer == "sgd") for t in trials), device)
        self.is_adamw = column((float(t.optimizer == "adamw") for t in trials), device)
        self.activation = torch.tensor(
            [[float(t.activation == name) for name in ACTIVATIONS] for t in trials], device=device
        ).view(count, len(ACTIVATIONS), 1, 1)
        self.batch_sizes = torch.tensor([t.batch_size for t in trials], device=device)

    def act(self, z: torch.Tensor) -> torch.Tensor:
        """Each model's activation, chosen by its one-hot row."""
        choices = torch.stack(
            (torch.relu(z), torch.nn.functional.gelu(z), torch.tanh(z), torch.nn.functional.silu(z)),
            dim=1,
        )
        return (choices * self.activation).sum(dim=1)

    def forward(self, x: torch.Tensor, train: bool, generator: torch.Generator) -> torch.Tensor:
        """Logits [models, batch, classes] for inputs [models, batch, features]."""

        def drop(h: torch.Tensor) -> torch.Tensor:
            if not train:
                return h
            keep = torch.rand(h.shape, generator=generator, device=self.device) >= self.dropout
            return h * keep / (1.0 - self.dropout)

        h = drop(self.act(torch.baddbmm(self.b_in, x, self.w_in)) * self.units)
        for index, (weights, bias) in enumerate(zip(self.w_hidden, self.b_hidden, strict=True)):
            inner = drop(self.act(torch.baddbmm(bias, h, weights)) * self.units)
            active = self.layers[:, index].view(-1, 1, 1)
            h = active * inner + (1.0 - active) * h
        return torch.baddbmm(self.b_out, h, self.w_out)

    def losses(self, logits: torch.Tensor, labels: torch.Tensor, rows: torch.Tensor) -> torch.Tensor:
        """Mean label-smoothed cross entropy per model over its `rows` mask [models, batch]."""
        log_probs = torch.log_softmax(logits, dim=-1)
        nll = -log_probs.gather(-1, labels.unsqueeze(-1)).squeeze(-1)
        smooth = -log_probs.mean(dim=-1)
        per_row = (1.0 - self.smoothing) * nll + self.smoothing * smooth
        return (per_row * rows).sum(dim=1) / rows.sum(dim=1)

    def step(self, active: torch.Tensor, step_number: int) -> None:
        """One optimizer step for the `active` models: SGD with momentum, Adam or AdamW."""
        with torch.no_grad():
            beta1, beta2, epsilon = 0.9, 0.999, 1e-8
            alive = active.float().view(-1, 1, 1)
            correction1 = 1.0 - beta1**step_number
            correction2 = 1.0 - beta2**step_number
            for parameter, first, second in zip(self.parameters, self.first_moment, self.second_moment, strict=True):
                gradient = parameter.grad
                if gradient is None:
                    raise RuntimeError("A parameter has no gradient")
                # L2 for SGD and Adam, decoupled decay for AdamW.
                coupled = gradient + (1.0 - self.is_adamw) * self.weight_decay * parameter
                velocity = 0.9 * first + coupled
                adam_first = beta1 * first + (1.0 - beta1) * coupled
                new_first = self.is_sgd * velocity + (1.0 - self.is_sgd) * adam_first
                new_second = beta2 * second + (1.0 - beta2) * coupled * coupled
                adam_update = (new_first / correction1) / (torch.sqrt(new_second / correction2) + epsilon)
                update = self.is_sgd * new_first + (1.0 - self.is_sgd) * adam_update
                decay = self.is_adamw * self.weight_decay * parameter
                parameter.sub_(alive * self.lr * (update + decay))
                first.copy_(alive * new_first + (1.0 - alive) * first)
                second.copy_(alive * new_second + (1.0 - alive) * second)
                parameter.grad = None


def steps_of(trial: Trial, rows: int) -> int:
    """Optimizer steps of a trial: its epochs of `rows` training rows in batches."""
    return math.ceil(rows / trial.batch_size) * trial.epochs


def train_round(
    trials: Sequence[Trial], data: Digits, device: torch.device, seed: int, group: int
) -> list[dict[str, Any]]:
    """Trains a round in groups of similar step counts; one result row per trial, in order.

    Every model of a group computes until the group's longest one is done, on
    batches and hidden layers as large as its largest, so models are grouped
    by step count: small batches (many steps) train together, on small
    batches, and nothing waits on a model ten times longer.
    """
    rows = len(data.y_train)
    ordered = sorted(trials, key=lambda trial: (steps_of(trial, rows), trial.batch_size, trial.width))
    by_number: dict[int, dict[str, Any]] = {}
    for start in range(0, len(ordered), group):
        chunk = ordered[start : start + group]
        for result in train_group(chunk, data, device, seed + start):
            by_number[int(result["uid"])] = result
    return [by_number[trial.number] for trial in trials]


def train_group(trials: Sequence[Trial], data: Digits, device: torch.device, seed: int) -> list[dict[str, Any]]:
    """Trains a group of models at once and returns one result row per trial."""
    generator = torch.Generator(device=device).manual_seed(seed)
    population = Population(trials, device, generator)
    count = len(trials)
    rows_train = len(data.y_train)
    steps_per_epoch = [math.ceil(rows_train / t.batch_size) for t in trials]
    total_steps = torch.tensor([s * t.epochs for s, t in zip(steps_per_epoch, trials, strict=True)], device=device)
    epoch_length = torch.tensor(steps_per_epoch, device=device)
    max_batch = max(t.batch_size for t in trials)
    row_mask = (torch.arange(max_batch, device=device) < population.batch_sizes.view(-1, 1)).float()
    longest = int(total_steps.max().item())

    epoch_loss_sum = torch.zeros(count, device=device)
    epoch_loss_steps = torch.zeros(count, device=device)
    train_loss = torch.full((count,), math.nan, device=device)
    val_loss = torch.full((count,), math.nan, device=device)
    val_accuracy = torch.full((count,), math.nan, device=device)
    best_val_loss = torch.full((count,), math.inf, device=device)
    best_epoch = torch.zeros(count, dtype=torch.long, device=device)
    diverged = torch.zeros(count, dtype=torch.bool, device=device)
    x_val = data.x_val.unsqueeze(0).expand(count, -1, -1)
    y_val = data.y_val.unsqueeze(0).expand(count, -1)
    val_rows = torch.ones((count, len(data.y_val)), device=device)

    started = time.perf_counter()
    for step in range(longest):
        active = (step < total_steps) & ~diverged
        indices = torch.randint(rows_train, (count, max_batch), generator=generator, device=device)
        logits = population.forward(data.x_train[indices], train=True, generator=generator)
        losses = population.losses(logits, data.y_train[indices], row_mask)
        finite = torch.isfinite(losses)
        torch.where(finite, losses, torch.zeros_like(losses)).sum().backward()
        population.step(active & finite, step + 1)
        with torch.no_grad():
            diverged |= active & (~finite | (losses > DIVERGED_LOSS))
            for parameter in population.parameters:
                parameter.nan_to_num_(nan=0.0, posinf=0.0, neginf=0.0)
            counted = active.float()
            epoch_loss_sum += torch.where(finite, losses, torch.zeros_like(losses)) * counted
            epoch_loss_steps += counted
            ends = active & ((step + 1) % epoch_length == 0)
            if not bool(ends.any()):
                continue
            val_logits = population.forward(x_val, train=False, generator=generator)
            losses_val = population.losses(val_logits, y_val, val_rows)
            accuracy = (val_logits.argmax(dim=-1) == y_val).float().mean(dim=1)
            epoch = (step + 1) // epoch_length
            train_loss = torch.where(ends, epoch_loss_sum / epoch_loss_steps.clamp(min=1), train_loss)
            val_loss = torch.where(ends, losses_val, val_loss)
            val_accuracy = torch.where(ends, accuracy, val_accuracy)
            improved = ends & (losses_val < best_val_loss)
            best_val_loss = torch.where(improved, losses_val, best_val_loss)
            best_epoch = torch.where(improved, epoch, best_epoch)
            epoch_loss_sum = torch.where(ends, torch.zeros_like(epoch_loss_sum), epoch_loss_sum)
            epoch_loss_steps = torch.where(ends, torch.zeros_like(epoch_loss_steps), epoch_loss_steps)
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    elapsed = time.perf_counter() - started

    results: list[dict[str, Any]] = []
    for index, trial in enumerate(trials):
        failed = bool(diverged[index].item())
        results.append(
            {
                "uid": str(trial.number),
                "lr": trial.lr,
                "weight_decay": trial.weight_decay,
                "width": trial.width,
                "depth": trial.depth,
                "dropout": trial.dropout,
                "batch_size": trial.batch_size,
                "optimizer": trial.optimizer,
                "activation": trial.activation,
                "epochs": trial.epochs,
                "label_smoothing": trial.label_smoothing,
                "params": parameter_count(trial),
                "train_loss": math.nan if failed else float(train_loss[index].item()),
                "val_loss": math.nan if failed else float(val_loss[index].item()),
                "best_val_loss": math.nan if failed else float(best_val_loss[index].item()),
                "best_epoch": int(best_epoch[index].item()),
                "val_accuracy": float(val_accuracy[index].item()) if not failed else math.nan,
                "diverged": failed,
                "wall_time_s": elapsed * float(total_steps[index].item()) / longest,
            }
        )
    return results


def objective_value(row: dict[str, Any]) -> float:
    """What TPE minimizes: the best validation loss, with diverged runs as failures."""
    loss = float(row["best_val_loss"])
    return loss if math.isfinite(loss) else 10.0 * DIVERGED_LOSS


def write_page(rows: Sequence[dict[str, Any]], out: Path) -> None:
    experiment = hip.Experiment.from_iterable(rows)
    for log_column in ("lr", "weight_decay", "val_loss", "best_val_loss", "train_loss"):
        experiment.parameters_definition[log_column].type = hip.ValueType.NUMERIC_LOG
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
                "diverged",
            ],
            "hide": ["uid", "params", "wall_time_s", "best_val_loss"],
        }
    )
    experiment.display_data(hip.Displays.XY).update({"axis_x": "lr", "axis_y": "val_accuracy"})
    experiment.display_data(hip.Displays.TABLE).update({"order_by": [["val_accuracy", "desc"]]})
    out.parent.mkdir(parents=True, exist_ok=True)
    experiment.to_html(out)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True, help="HiPlot page to write")
    parser.add_argument("--csv", type=Path, help="also write the trials as CSV")
    parser.add_argument("--trials", type=int, default=10_000)
    parser.add_argument("--round", type=int, default=1000, help="trials proposed at once")
    parser.add_argument("--group", type=int, default=250, help="trials trained at once")
    parser.add_argument("--random-trials", type=int, default=2000, help="random trials before TPE")
    parser.add_argument("--window", type=int, default=1000, help="recent trials TPE learns from")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args(argv)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"device: {device} ({torch.cuda.get_device_name(device) if device.type == 'cuda' else 'CPU'})", flush=True)
    torch.manual_seed(args.seed)
    data = load_data(device, args.seed)
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    rows: list[dict[str, Any]] = []
    completed: list[optuna.trial.FrozenTrial] = []
    started = time.perf_counter()
    while len(rows) < args.trials:
        size = min(args.round, args.trials - len(rows))
        # Random search first; then multivariate TPE fitted to the most recent
        # trials. An Optuna ask costs time linear in the history, so a window
        # keeps ten thousand proposals to minutes; a round is proposed from
        # the same model, without constant-liar bookkeeping between its asks.
        sampler: optuna.samplers.BaseSampler = (
            optuna.samplers.RandomSampler(seed=args.seed + len(rows))
            if len(rows) < args.random_trials
            else optuna.samplers.TPESampler(seed=args.seed + len(rows), n_startup_trials=0, multivariate=True)
        )
        study = optuna.create_study(direction="minimize", sampler=sampler)
        study.add_trials(completed[-args.window :])
        asked = [study.ask() for _ in range(size)]
        trials = [propose(trial, len(rows) + index) for index, trial in enumerate(asked)]
        proposed = time.perf_counter()
        results = train_round(trials, data, device, args.seed + len(rows), args.group)
        for trial, result in zip(asked, results, strict=True):
            study.tell(trial, objective_value(result))
        completed.extend(study.trials[-size:])
        rows.extend(results)
        best = min(objective_value(row) for row in rows)
        print(
            f"{len(rows):>6} trials  best val loss {best:.4f}  elapsed {time.perf_counter() - started:6.1f} s "
            f"(training {time.perf_counter() - proposed:5.1f} s)",
            flush=True,
        )
    write_page(rows, args.out)
    print(f"wrote {args.out}")
    if args.csv is not None:
        with args.csv.open("w", encoding="utf-8", newline="") as csv_file:
            hip.Experiment.from_iterable(rows).to_csv(csv_file)
        print(f"wrote {args.csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
