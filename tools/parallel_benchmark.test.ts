import { expect, test } from "bun:test";
import { parallelExperiment, quantile } from "../bench/parallel_data";
import { profileSortedIndex } from "../bench/parallel_index";

const config = { rows: 100, columns: 10, discrete: false, seed: 20261109 };

test("the million-row benchmark payload has stable named numeric columns and identities", () => {
  const experiment = parallelExperiment(config);
  expect(experiment).toEqual(parallelExperiment(config));
  const data = experiment.datapoints_columnar;
  expect(data?.uid).toEqual(Array.from({ length: 100 }, (_, row) => String(row)));
  expect(data?.from_uid).toEqual(new Array(100).fill(null));
  expect(Object.keys(data?.columns ?? {})).toHaveLength(10);
  for (const values of Object.values(data?.columns ?? {})) {
    expect(values).toHaveLength(100);
    expect(values.every((value) => typeof value === "number" && value >= 0 && value < 1)).toBe(
      true,
    );
  }
  expect(experiment.enabled_displays).toEqual(["PARALLEL_PLOT"]);
  expect(parallelExperiment({ ...config, seed: 1 })).not.toEqual(experiment);
});

test("the low-cardinality benchmark quantizes the same seeded continuous values", () => {
  const continuous = parallelExperiment(config).datapoints_columnar;
  const discrete = parallelExperiment({ ...config, discrete: true }).datapoints_columnar;
  for (const [name, values] of Object.entries(continuous?.columns ?? {})) {
    expect(discrete?.columns[name]).toEqual(values.map((value) => Math.floor(Number(value) * 8)));
  }
});

test("timing quantiles sort without modifying the samples and reject empty series", () => {
  const times = [8, 1, 3, 2];
  expect(quantile(times, 0.5)).toBe(3);
  expect(quantile(times, 0.95)).toBe(8);
  expect(quantile(times, 1)).toBe(8);
  expect(times).toEqual([8, 1, 3, 2]);
  expect(() => quantile([], 0.5)).toThrow("empty timing series");
});

test("sorted-index profiling verifies each changed mask against a scan", () => {
  for (const discrete of [false, true]) {
    const result = profileSortedIndex(500, discrete);
    expect(result.steps).toBe(120);
    expect(result.maximumChanged).toBeGreaterThan(0);
    expect(result.totalChanged).toBeGreaterThanOrEqual(result.maximumChanged);
    expect(result.scanTotalMs).toBeGreaterThanOrEqual(0);
    expect(result.indexWithBuildMs).toBeGreaterThanOrEqual(result.buildMs);
  }
});
