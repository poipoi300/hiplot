import type { DatapointsColumnar, HiPlotExperiment } from "../src/types";

export interface ParallelBenchmarkConfig {
  rows: number;
  columns: number;
  discrete: boolean;
  seed: number;
}

/** Seeded numeric columns; self-contained so Playwright can install it in the page. */
export function parallelExperiment(config: ParallelBenchmarkConfig): HiPlotExperiment {
  let seed = config.seed >>> 0;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const data: DatapointsColumnar = {
    uid: Array.from({ length: config.rows }, (_, row) => String(row)),
    from_uid: new Array<string | null>(config.rows).fill(null),
    columns: {},
    missing: {},
  };
  for (let column = 0; column < config.columns; ++column) {
    const values = new Array<number>(config.rows);
    for (let row = 0; row < config.rows; ++row) {
      const value = random();
      values[row] = config.discrete ? Math.floor(value * 8) : value;
    }
    data.columns[`numeric_column_${String(column).padStart(2, "0")}`] = values;
  }
  return {
    datapoints_columnar: data,
    colorby: "numeric_column_00",
    enabled_displays: ["PARALLEL_PLOT"],
    display_data: { PARALLEL_PLOT: { renderQuality: "full" } },
  };
}

export function quantile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    throw new Error("Cannot summarize an empty timing series");
  }
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(fraction * ordered.length))];
}
