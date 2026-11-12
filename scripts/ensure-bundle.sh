#!/usr/bin/env bash
set -euo pipefail

bundle="hiplot/static/built/hiplot.bundle.js"

if [ ! -f "$bundle" ]; then
  echo "HiPlot bundle missing, building..."
  bun run build
  exit 0
fi

if find src rust/src rust/Cargo.toml rust/Cargo.lock -type f -newer "$bundle" -print -quit | grep -q .; then
  echo "HiPlot bundle is stale, rebuilding..."
  bun run build
fi
