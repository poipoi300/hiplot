"""The hyperparameter search behind tune.py: thousands of small MLPs trained at once.

Trains small MLPs on the UCI handwritten digits (8x8 images, shipped with
scikit-learn, so nothing is downloaded). Optuna's TPE sampler proposes the
trials in rounds: random search first, then proposals from the trials seen so
far, so the distributions it leaves are shaped by the loss landscape.

Trials train on the GPU a few hundred at once, grouped by step count. Each
model's parameters are a slice of stacked tensors, and the hyperparameters
that change a model's shape or schedule become masks: hidden units beyond its width are zeroed, hidden
layers beyond its depth pass their input through, each model reads only the
first `batch_size` rows of the shared minibatch tensor, and a model stops
updating after its own number of steps. Activations, optimizers, dropout,
weight decay and label smoothing are applied per model.
"""

import math
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

import optuna
import torch
from sklearn.datasets import load_digits
from sklearn.linear_model import LogisticRegression

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
    """The digits split once into training, validation and test rows, on the device.

    Validation picks each trial's epoch and the search's direction. Test plays
    no part in any choice: only the re-scored top configurations and the
    baselines are evaluated on it.
    """

    x_train: torch.Tensor
    y_train: torch.Tensor
    x_val: torch.Tensor
    y_val: torch.Tensor
    x_test: torch.Tensor
    y_test: torch.Tensor


def load_data(device: torch.device, seed: int) -> Digits:
    digits = load_digits()
    x = torch.tensor(digits.data, dtype=torch.float32) / 16.0
    y = torch.tensor(digits.target, dtype=torch.long)
    order = torch.randperm(len(y), generator=torch.Generator().manual_seed(seed))
    train_end, val_end = int(0.7 * len(y)), int(0.85 * len(y))
    train, val, test = order[:train_end], order[train_end:val_end], order[val_end:]
    return Digits(*(tensor.to(device) for tensor in (x[train], y[train], x[val], y[val], x[test], y[test])))


def selection_score[Metric: (float, torch.Tensor)](error: Metric, loss: Metric, rows: int) -> Metric:
    """Validation error, ties broken by cross entropy.

    The tie-break term is below half of one example's share of the error, so it
    only orders checkpoints and trials whose error is equal.
    """
    return error + (0.5 / rows) * loss / (1.0 + loss)


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

    def validation_losses(self, logits: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
        """Mean plain cross entropy per model [models, rows].

        Label smoothing is a training regularizer: a smoothed loss has a floor
        that grows with the smoothing amount, so scoring validation with it
        would rank trials by their smoothing rather than their predictions.
        """
        log_probs = torch.log_softmax(logits, dim=-1)
        return -log_probs.gather(-1, labels.unsqueeze(-1)).squeeze(-1).mean(dim=1)

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
    trials: Sequence[Trial], data: Digits, device: torch.device, seed: int, group: int, score_test: bool = False
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
        for result in train_group(chunk, data, device, seed + start, score_test):
            by_number[int(result["uid"])] = result
    return [by_number[trial.number] for trial in trials]


def train_group(
    trials: Sequence[Trial], data: Digits, device: torch.device, seed: int, score_test: bool
) -> list[dict[str, Any]]:
    """Trains a group of models at once and returns one result row per trial.

    With `score_test`, each row also carries the test error and loss of the
    kept checkpoint; the search itself never asks for them.
    """
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

    def unset() -> torch.Tensor:
        return torch.full((count,), math.nan, device=device)

    last_train_loss, last_val_loss, last_val_error = unset(), unset(), unset()
    best_score = torch.full((count,), math.inf, device=device)
    best_val_error, best_val_loss, best_train_loss = unset(), unset(), unset()
    best_test_error, best_test_loss = unset(), unset()
    best_epoch = torch.zeros(count, dtype=torch.long, device=device)
    diverged = torch.zeros(count, dtype=torch.bool, device=device)
    x_val = data.x_val.unsqueeze(0).expand(count, -1, -1)
    y_val = data.y_val.unsqueeze(0).expand(count, -1)
    x_test = data.x_test.unsqueeze(0).expand(count, -1, -1)
    y_test = data.y_test.unsqueeze(0).expand(count, -1)
    val_rows = len(data.y_val)

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
            losses_val = population.validation_losses(val_logits, y_val)
            error_val = (val_logits.argmax(dim=-1) != y_val).float().mean(dim=1)
            epoch = (step + 1) // epoch_length
            epoch_train_loss = epoch_loss_sum / epoch_loss_steps.clamp(min=1)
            last_train_loss = torch.where(ends, epoch_train_loss, last_train_loss)
            last_val_loss = torch.where(ends, losses_val, last_val_loss)
            last_val_error = torch.where(ends, error_val, last_val_error)
            # The kept checkpoint is the epoch with the lowest validation error, ties
            # broken by cross entropy; every best_* metric is read at that same epoch.
            score = selection_score(error_val, losses_val, val_rows)
            improved = ends & (score < best_score)
            best_score = torch.where(improved, score, best_score)
            best_val_error = torch.where(improved, error_val, best_val_error)
            best_val_loss = torch.where(improved, losses_val, best_val_loss)
            best_train_loss = torch.where(improved, epoch_train_loss, best_train_loss)
            best_epoch = torch.where(improved, epoch, best_epoch)
            if score_test:
                test_logits = population.forward(x_test, train=False, generator=generator)
                error_test = (test_logits.argmax(dim=-1) != y_test).float().mean(dim=1)
                best_test_error = torch.where(improved, error_test, best_test_error)
                best_test_loss = torch.where(
                    improved, population.validation_losses(test_logits, y_test), best_test_loss
                )
            epoch_loss_sum = torch.where(ends, torch.zeros_like(epoch_loss_sum), epoch_loss_sum)
            epoch_loss_steps = torch.where(ends, torch.zeros_like(epoch_loss_steps), epoch_loss_steps)
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    elapsed = time.perf_counter() - started

    results: list[dict[str, Any]] = []
    for index, trial in enumerate(trials):
        failed = bool(diverged[index].item())
        # A trial that diverged after an improving epoch still has a valid kept
        # checkpoint; its last-epoch values describe a run that never finished.
        kept = int(best_epoch[index].item()) > 0

        def at_kept(metric: torch.Tensor, index: int = index, kept: bool = kept) -> float:
            return float(metric[index].item()) if kept else math.nan

        def at_last(metric: torch.Tensor, index: int = index, failed: bool = failed) -> float:
            return math.nan if failed else float(metric[index].item())

        results.append(
            {
                "uid": trial.number,
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
                "best_val_error": at_kept(best_val_error),
                "best_val_loss": at_kept(best_val_loss),
                "best_train_loss": at_kept(best_train_loss),
                "best_epoch": int(best_epoch[index].item()),
                **(
                    {"best_test_error": at_kept(best_test_error), "best_test_loss": at_kept(best_test_loss)}
                    if score_test
                    else {}
                ),
                "last_val_error": at_last(last_val_error),
                "last_val_loss": at_last(last_val_loss),
                "last_train_loss": at_last(last_train_loss),
                "diverged": failed,
                "wall_time_s": elapsed * float(total_steps[index].item()) / longest,
            }
        )
    return results


def objective_value(row: dict[str, Any], val_rows: int) -> float:
    """What TPE minimizes: the kept checkpoint's selection score; runs without one score as failures.

    Failures score 2, above the worst possible error of 1 plus its tie-break.
    """
    error, loss = float(row["best_val_error"]), float(row["best_val_loss"])
    if not (math.isfinite(error) and math.isfinite(loss)):
        return 2.0
    score: float = selection_score(error, loss, val_rows)
    return score


def rescore(
    rows: Sequence[dict[str, Any]], data: Digits, device: torch.device, settings: "SearchSettings"
) -> dict[int, dict[str, float]]:
    """Retrains the top configurations over several seeds and scores their kept checkpoints on test.

    The search picked these trials as the best of thousands on the validation
    split, so their own validation error is optimistic (winner's curse). Fresh
    seeds give the spread a configuration really has, and the test split, which
    played no part in any choice, gives an unbiased error.
    """
    val_rows = len(data.y_val)
    ranked = sorted(rows, key=lambda row: objective_value(row, val_rows))[: settings.rescore_top]
    configs = [
        Trial(**{name: row[name] for name in Trial.__dataclass_fields__ if name != "number"}, number=int(row["uid"]))
        for row in ranked
    ]
    by_uid: dict[int, list[dict[str, Any]]] = {config.number: [] for config in configs}
    for seed_index in range(settings.rescore_seeds):
        seed = settings.seed + 1_000_000 + seed_index
        for result in train_round(configs, data, device, seed, settings.group, score_test=True):
            by_uid[int(result["uid"])].append(result)

    def spread(results: Sequence[dict[str, Any]], name: str) -> tuple[float, float]:
        values = torch.tensor([float(result[name]) for result in results], dtype=torch.float64)
        finite = values[values.isfinite()]
        # Seeds without a kept checkpoint are counted in seeds_failed, not averaged.
        mean = float(finite.mean()) if len(finite) > 0 else math.nan
        return mean, float(finite.std()) if len(finite) > 1 else math.nan

    summary: dict[int, dict[str, float]] = {}
    for uid, results in by_uid.items():
        val_mean, val_std = spread(results, "best_val_error")
        test_mean, test_std = spread(results, "best_test_error")
        summary[uid] = {
            "seeds_val_error": val_mean,
            "seeds_val_error_std": val_std,
            "seeds_failed": sum(not math.isfinite(float(result["best_val_error"])) for result in results),
            "test_error": test_mean,
            "test_error_std": test_std,
        }
    return summary


def baselines(data: Digits) -> list[dict[str, Any]]:
    """Untuned reference models, scored on the same validation and test splits as the trials."""

    def error(predicted: torch.Tensor, labels: torch.Tensor) -> float:
        return float((predicted != labels).float().mean())

    majority = torch.bincount(data.y_train, minlength=CLASSES).argmax()
    nearest = data.y_train[torch.cdist(data.x_val, data.x_train).argmin(dim=1)]
    nearest_test = data.y_train[torch.cdist(data.x_test, data.x_train).argmin(dim=1)]
    logistic = LogisticRegression(max_iter=5000).fit(data.x_train.cpu().numpy(), data.y_train.cpu().numpy())

    def logistic_predict(x: torch.Tensor) -> torch.Tensor:
        return torch.as_tensor(logistic.predict(x.cpu().numpy()), device=x.device)

    predictions = {
        "majority class": (majority.expand(len(data.y_val)), majority.expand(len(data.y_test))),
        "1-nearest neighbour": (nearest, nearest_test),
        "logistic regression": (logistic_predict(data.x_val), logistic_predict(data.x_test)),
    }
    return [
        {
            "uid": -(index + 1),
            "model": name,
            "best_val_error": error(val, data.y_val),
            "test_error": error(test, data.y_test),
        }
        for index, (name, (val, test)) in enumerate(predictions.items())
    ]


@dataclass(frozen=True)
class SearchSettings:
    """How many trials to run, and how the sampler and the GPU batches are sized."""

    trials: int
    round: int
    group: int
    random_trials: int
    window: int
    seed: int
    rescore_top: int
    rescore_seeds: int


def run_search(settings: SearchSettings) -> list[dict[str, Any]]:
    """Runs the search; one result row per trial, in the order they were proposed."""
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"device: {device} ({torch.cuda.get_device_name(device) if device.type == 'cuda' else 'CPU'})", flush=True)
    torch.manual_seed(settings.seed)
    data = load_data(device, settings.seed)
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    rows: list[dict[str, Any]] = []
    completed: list[optuna.trial.FrozenTrial] = []
    started = time.perf_counter()
    while len(rows) < settings.trials:
        size = min(settings.round, settings.trials - len(rows))
        # Random search first; then multivariate TPE fitted to the most recent
        # `window` trials. A window as long as the search lets TPE keep every
        # good region it has seen; a short one makes each round learn only from
        # the last round's own proposals and narrow early. An ask costs time
        # linear in the history. A round is proposed from the same model,
        # without constant-liar bookkeeping between its asks.
        sampler: optuna.samplers.BaseSampler = (
            optuna.samplers.RandomSampler(seed=settings.seed + len(rows))
            if len(rows) < settings.random_trials
            else optuna.samplers.TPESampler(seed=settings.seed + len(rows), n_startup_trials=0, multivariate=True)
        )
        study = optuna.create_study(direction="minimize", sampler=sampler)
        study.add_trials(completed[-settings.window :])
        asked = [study.ask() for _ in range(size)]
        trials = [propose(trial, len(rows) + index) for index, trial in enumerate(asked)]
        proposed = time.perf_counter()
        results = train_round(trials, data, device, settings.seed + len(rows), settings.group)
        for trial, result in zip(asked, results, strict=True):
            study.tell(trial, objective_value(result, len(data.y_val)))
        completed.extend(study.trials[-size:])
        rows.extend(results)
        best = min(rows, key=lambda row: objective_value(row, len(data.y_val)))
        print(
            f"{len(rows):>6} trials  best val error {best['best_val_error']:.4f} (loss {best['best_val_loss']:.4f})  "
            f"elapsed {time.perf_counter() - started:6.1f} s (training {time.perf_counter() - proposed:5.1f} s)",
            flush=True,
        )
    rescored = rescore(rows, data, device, settings)
    unscored = dict.fromkeys(next(iter(rescored.values())), math.nan)
    trial_rows = [{**row, "model": "mlp", **rescored.get(int(row["uid"]), unscored)} for row in rows]
    print(f"rescored the top {len(rescored)} configurations over {settings.rescore_seeds} seeds", flush=True)
    return trial_rows + baselines(data)
