#!/usr/bin/env bash
# Build the bundle, render the benchmark experiments with it, and measure them in
# Chromium. Extra arguments go to bench/run.ts (e.g. --reps 1 --label mine).
set -euo pipefail

OUT="${HIPLOT_BENCH_DIR:-${TMPDIR:-/tmp}/hiplot-bench}"
bun run build
uv run python bench/make_experiments.py --out "${OUT}"
node bench/run.ts --dir "${OUT}" "$@"
