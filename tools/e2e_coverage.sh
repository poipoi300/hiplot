#!/usr/bin/env bash
# Run the Playwright suite against an istanbul-instrumented web bundle and
# write the TypeScript line coverage it produced to coverage/e2e/lcov.info.
# Used by tools/stack_coverage_gate.sh locally and by the CI Playwright job,
# whose report the CI coverage job then reuses.
set -euo pipefail

rm -rf .nyc_output coverage/e2e
bun run tcm
HIPLOT_COVERAGE=1 bun run vite:build:web

# The suite's fixture (tests/fixtures.ts) dumps window.__coverage__ into
# .nyc_output after every test when HIPLOT_COVERAGE is set.
status=0
HIPLOT_COVERAGE=1 bun run test:js "$@" || status=$?

# Never leave the instrumented bundle where the Python package picks it up.
bun run vite:build:web

bun run nyc report --temp-dir .nyc_output --reporter=lcovonly --report-dir coverage/e2e
exit "${status}"
