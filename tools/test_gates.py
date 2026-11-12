"""The gate registry must stay in sync with the actual hook/CI configs."""

import re
from pathlib import Path
from typing import Any

import yaml

from tools.gates import DETERMINISTIC_GATES, GateStage, gates_for_stage

REPO_ROOT = Path(__file__).resolve().parent.parent


def _precommit_hooks() -> list[dict[str, Any]]:
    config = yaml.safe_load((REPO_ROOT / ".pre-commit-config.yaml").read_text(encoding="utf-8"))
    return [hook for repo in config["repos"] for hook in repo["hooks"]]


def test_registry_matches_precommit_config() -> None:
    registry_ids = {g.name for g in DETERMINISTIC_GATES}
    assert registry_ids == {hook["id"] for hook in _precommit_hooks()}


def test_registry_stages_match_precommit_config() -> None:
    config_stages = {hook["id"]: tuple(hook.get("stages", ["pre-commit"])) for hook in _precommit_hooks()}
    assert {g.name: (g.stage.value,) for g in DETERMINISTIC_GATES} == config_stages


def test_every_hook_is_a_local_system_hook() -> None:
    assert {hook.get("language") for hook in _precommit_hooks()} == {"system"}


def test_push_stage_holds_only_slow_gates() -> None:
    assert {g.name for g in gates_for_stage(GateStage.PUSH)} == {"tests-and-diff-coverage"}


def test_ci_enforced_gates_appear_in_workflow() -> None:
    workflow_text = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    # CI runs the tools directly rather than via pre-commit; map hook id -> the
    # command substring that proves the gate is present in the workflow.
    expected_evidence = {
        "ruff-format": "ruff format --check",
        "ruff-check": "ruff check",
        "mypy": "mypy .",
        "biome": "biome check --error-on-warnings .",
        "tsc": "bun run typecheck",
        "rust-fmt": "cargo fmt --manifest-path rust/Cargo.toml --check",
        "rust-clippy": "cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings",
    }
    ci_gates = {g.name for g in DETERMINISTIC_GATES if g.ci_enforced}
    assert ci_gates == set(expected_evidence)
    for evidence in expected_evidence.values():
        assert evidence in workflow_text


def test_ci_runs_unit_tests_without_a_browser_dependency() -> None:
    config = yaml.safe_load((REPO_ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8"))
    job = config["jobs"]["unit-tests"]
    assert job["needs"] == "build-js"
    commands = [step["run"] for step in job["steps"] if "run" in step]
    assert "uv run pytest -q" in commands
    assert "bun test ./src ./tools" in commands
    for workflow in (REPO_ROOT / ".github/workflows").glob("*.yml"):
        text = workflow.read_text(encoding="utf-8")
        for browser_dependency in ("playwright", "test:js", "e2e_coverage.sh", "stack_coverage_gate.sh", "E2E_LCOV"):
            assert browser_dependency not in text, f"{workflow.name}: hosted browser dependency {browser_dependency}"


def test_local_push_gate_keeps_browser_tests_and_combined_coverage() -> None:
    gate = next(g for g in DETERMINISTIC_GATES if g.name == "tests-and-diff-coverage")
    assert gate.stage is GateStage.PUSH
    assert gate.ci_enforced is False
    hook = next(h for h in _precommit_hooks() if h["id"] == gate.name)
    assert hook["entry"] == "bash tools/stack_coverage_gate.sh"
    script = (REPO_ROOT / "tools/stack_coverage_gate.sh").read_text(encoding="utf-8")
    assert "bash tools/e2e_coverage.sh" in script
    assert "${DIFF_COVER_FAIL_UNDER:-90}" in script
    assert '"${REPORTS}/python.lcov" "${E2E_LCOV}"' in script
    assert '--bun "${REPORTS}/unit/lcov.info"' in script


def test_workflow_actions_are_pinned_to_commit_shas() -> None:
    pinned = re.compile(r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$")
    for workflow in (REPO_ROOT / ".github" / "workflows").glob("*.yml"):
        for line in workflow.read_text(encoding="utf-8").splitlines():
            stripped = line.strip().removeprefix("- ")
            if not stripped.startswith("uses:"):
                continue
            action = stripped.removeprefix("uses:").split("#")[0].strip()
            if action.startswith("./"):
                continue
            assert pinned.match(action), f"{workflow.name}: {action} is not pinned to a commit SHA"
