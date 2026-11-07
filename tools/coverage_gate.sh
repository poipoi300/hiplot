#!/usr/bin/env bash
# Run the test suite under coverage, then require >=90% coverage on the lines
# this branch changed relative to its merge base with the comparison branch.
# Used by the pre-push hook and by CI so both enforce the same threshold.
set -euo pipefail

COMPARE_BRANCH="${DIFF_COVER_COMPARE_BRANCH:-origin/main}"
FAIL_UNDER="${DIFF_COVER_FAIL_UNDER:-90}"

# Tests marked "live" self-skip when their endpoint is unreachable (see
# test/agent_test.py), so no marker filtering is needed here.
uv run coverage run -m pytest
uv run coverage xml -o coverage.xml

# diff-cover needs the comparison branch present locally. In a fresh clone/CI
# checkout it may be missing; fetch it best-effort before comparing.
if ! git rev-parse --verify -q "${COMPARE_BRANCH}" >/dev/null; then
  git fetch --quiet origin "${COMPARE_BRANCH#origin/}" || true
fi

uv run diff-cover coverage.xml \
  --compare-branch="${COMPARE_BRANCH}" \
  --fail-under="${FAIL_UNDER}"
