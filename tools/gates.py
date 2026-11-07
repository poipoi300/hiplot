"""Gate registry: the deterministic checks this repo carries.

A machine-readable mirror of `.pre-commit-config.yaml` and
`.github/workflows/ci.yml`, so tooling reasons about gates through this module
instead of grepping config files. `tools/test_gates.py` pins the mirror.

It lives in `tools/` rather than in the `hiplot` package because hiplot is a
published library and the gates describe this repository, not the library.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class GateStage(Enum):
    """When a gate runs in the local hook chain."""

    COMMIT = "pre-commit"
    PUSH = "pre-push"


@dataclass(frozen=True)
class Gate:
    """One deterministic quality gate.

    Attributes:
        name: Hook id as it appears in .pre-commit-config.yaml.
        stage: Whether it blocks commits or pushes.
        ci_enforced: Whether CI re-runs it server-side (hooks are bypassable).
    """

    name: str
    stage: GateStage
    ci_enforced: bool


DETERMINISTIC_GATES: tuple[Gate, ...] = (
    Gate("trailing-whitespace", GateStage.COMMIT, ci_enforced=False),
    Gate("end-of-file-fixer", GateStage.COMMIT, ci_enforced=False),
    Gate("check-merge-conflict", GateStage.COMMIT, ci_enforced=False),
    Gate("check-case-conflict", GateStage.COMMIT, ci_enforced=False),
    Gate("check-added-large-files", GateStage.COMMIT, ci_enforced=False),
    Gate("check-yaml", GateStage.COMMIT, ci_enforced=False),
    Gate("check-toml", GateStage.COMMIT, ci_enforced=False),
    Gate("check-json", GateStage.COMMIT, ci_enforced=False),
    Gate("debug-statements", GateStage.COMMIT, ci_enforced=False),
    Gate("detect-private-key", GateStage.COMMIT, ci_enforced=False),
    Gate("ruff-format", GateStage.COMMIT, ci_enforced=True),
    Gate("ruff-check", GateStage.COMMIT, ci_enforced=True),
    Gate("mypy", GateStage.COMMIT, ci_enforced=True),
    Gate("biome", GateStage.COMMIT, ci_enforced=True),
    Gate("tsc", GateStage.COMMIT, ci_enforced=True),
    Gate("tests-and-diff-coverage", GateStage.PUSH, ci_enforced=True),
)


def gates_for_stage(stage: GateStage) -> tuple[Gate, ...]:
    """Return the gates that run at the given hook stage."""
    return tuple(g for g in DETERMINISTIC_GATES if g.stage is stage)
