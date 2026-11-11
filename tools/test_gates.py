"""The gate registry must stay in sync with the actual hook/CI configs."""

import re
from pathlib import Path
from typing import Any

import yaml

from tools.gates import DETERMINISTIC_GATES, PLAYWRIGHT_CI_SHARDS, GateStage, gates_for_stage

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
        "tests-and-diff-coverage": "stack_coverage_gate.sh",
    }
    ci_gates = {g.name for g in DETERMINISTIC_GATES if g.ci_enforced}
    assert ci_gates == set(expected_evidence)
    for evidence in expected_evidence.values():
        assert evidence in workflow_text


def test_ci_shards_every_browser_test_and_retains_coverage() -> None:
    config = yaml.safe_load((REPO_ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8"))
    job = config["jobs"]["playwright"]
    assert job["strategy"]["matrix"]["shard"] == list(PLAYWRIGHT_CI_SHARDS)
    assert job["strategy"]["fail-fast"] is False
    steps = {step.get("name"): step for step in job["steps"]}
    run = steps["Playwright against an instrumented bundle"]["run"]
    assert run == "bash tools/e2e_coverage.sh --shard=${{ matrix.shard }}/" + str(len(PLAYWRIGHT_CI_SHARDS))
    artifact = steps["Upload end-to-end coverage"]["with"]
    assert artifact["name"] == "e2e-coverage-${{ matrix.shard }}"


def test_ci_requires_all_shards_before_the_stack_coverage_gate() -> None:
    config = yaml.safe_load((REPO_ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8"))
    job = config["jobs"]["tests-and-coverage"]
    assert "playwright" in job["needs"]
    steps = {step.get("name"): step for step in job["steps"]}
    assert steps["Download end-to-end coverage"]["with"]["pattern"] == "e2e-coverage-*"
    merge = steps["Merge every browser shard's coverage"]["run"]
    assert 'test "${#reports[@]}" -eq ' + str(len(PLAYWRIGHT_CI_SHARDS)) in merge
    assert 'tools/merge_lcov.py coverage/e2e/lcov.info "${reports[@]}"' in merge
    assert steps["Tests + diff coverage (Python, bun, Playwright)"]["env"]["E2E_LCOV"] == ("coverage/e2e/lcov.info")


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
