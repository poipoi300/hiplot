/** Isolated construction/query costs: no production sorted-index allocation. */

import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { bisector } from "d3";
import { parallelExperiment, quantile } from "./parallel_data";

export function profileSortedIndex(rows: number, discrete: boolean, steps = 120) {
  const data = parallelExperiment({ rows, columns: 1, discrete, seed: 20261109 });
  const values = Float64Array.from(
    data.datapoints_columnar?.columns.numeric_column_00 ?? [],
    Number,
  );
  const start = performance.now();
  const order = Uint32Array.from(values.keys()).sort(
    (left, right) => values[left] - values[right] || left - right,
  );
  const buildMs = performance.now() - start;
  const search = bisector((row: number) => values[row]);
  const flat = new Uint8Array(rows);
  const indexed = new Uint8Array(rows);
  const scanTimes: number[] = [];
  const indexTimes: number[] = [];
  let previousLeft = 0;
  let previousRight = 0;
  let maximumChanged = 0;
  let totalChanged = 0;
  for (let step = 0; step < steps; ++step) {
    const min = (discrete ? 7 : 1) * (0.15 + (0.2 * step) / Math.max(1, steps - 1));
    const max = min + (discrete ? 7 : 1) * 0.3;
    const scanStart = performance.now();
    for (let row = 0; row < rows; ++row) {
      flat[row] = Number(min <= values[row] && values[row] <= max);
    }
    scanTimes.push(performance.now() - scanStart);
    const indexStart = performance.now();
    const left = search.left(order, min);
    const right = search.right(order, max);
    let changed = 0;
    // Symmetric difference of old/new intervals; selected rows keep their flags.
    for (let slot = previousLeft; slot < Math.min(previousRight, left); ++slot) {
      indexed[order[slot]] = 0;
      ++changed;
    }
    for (let slot = Math.max(previousLeft, right); slot < previousRight; ++slot) {
      indexed[order[slot]] = 0;
      ++changed;
    }
    for (let slot = left; slot < Math.min(right, previousLeft); ++slot) {
      indexed[order[slot]] = 1;
      ++changed;
    }
    for (let slot = Math.max(left, previousRight); slot < right; ++slot) {
      indexed[order[slot]] = 1;
      ++changed;
    }
    indexTimes.push(performance.now() - indexStart);
    previousLeft = left;
    previousRight = right;
    totalChanged += changed;
    maximumChanged = Math.max(maximumChanged, changed);
    for (let row = 0; row < rows; ++row) {
      if (flat[row] !== indexed[row]) {
        throw new Error(`Sorted index changed row ${row} at step ${step}`);
      }
    }
  }
  const sum = (times: number[]) => times.reduce((total, value) => total + value, 0);
  return {
    rows,
    discrete,
    steps,
    buildMs,
    scanP50Ms: quantile(scanTimes, 0.5),
    indexP50Ms: quantile(indexTimes, 0.5),
    scanTotalMs: sum(scanTimes),
    indexWithBuildMs: buildMs + sum(indexTimes),
    maximumChanged,
    totalChanged,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  for (const discrete of [false, true]) {
    console.log(JSON.stringify(profileSortedIndex(1_000_000, discrete)));
  }
}
