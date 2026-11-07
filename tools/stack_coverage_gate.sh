#!/usr/bin/env bash
# Run every suite under coverage, then require >=90% coverage on the lines this
# branch changed relative to its merge base with the comparison branch, across
# Python and TypeScript at once: pytest, the bun unit tests, and the Playwright
# suite against an instrumented bundle. Used by the pre-push hook and by CI so
# both enforce the same threshold. Extends tools/coverage_gate.sh (kept
# verbatim from forge) to this stack.
#
# Set E2E_LCOV to reuse an end-to-end report produced elsewhere instead of
# running Playwright here (CI runs the suite in its own job).
set -euo pipefail

COMPARE_BRANCH="${DIFF_COVER_COMPARE_BRANCH:-origin/main}"
FAIL_UNDER="${DIFF_COVER_FAIL_UNDER:-90}"
REPORTS="coverage"
mkdir -p "${REPORTS}"

uv run coverage run -m pytest
uv run coverage lcov -o "${REPORTS}/python.lcov"

rm -rf "${REPORTS}/unit"
bun test --coverage --coverage-reporter=lcov --coverage-dir="${REPORTS}/unit"

if [ -z "${E2E_LCOV:-}" ]; then
  bash tools/e2e_coverage.sh
  E2E_LCOV="${REPORTS}/e2e/lcov.info"
fi

# One report, repo-relative paths, unit and end-to-end hits summed per line:
# diff-cover cannot mix Cobertura with LCOV, and matches git's diff paths.
uv run python tools/merge_lcov.py "${REPORTS}/merged.lcov" \
  "${REPORTS}/python.lcov" "${REPORTS}/unit/lcov.info" "${E2E_LCOV}"

# diff-cover needs the comparison branch present locally. In a fresh clone/CI
# checkout it may be missing; fetch it best-effort before comparing.
if ! git rev-parse --verify -q "${COMPARE_BRANCH}" >/dev/null; then
  git fetch --quiet origin "${COMPARE_BRANCH#origin/}" || true
fi

uv run diff-cover "${REPORTS}/merged.lcov" \
  --compare-branch="${COMPARE_BRANCH}" \
  --fail-under="${FAIL_UNDER}"
