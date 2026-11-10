import { loadParallelBenchmark } from "../bench/parallel";
import type { AxisSelection, BrushMasks } from "../src/parallel/selection";
import type { Datapoint, ParamType } from "../src/types";
import { expect, test } from "./fixtures";

test("offline worker indices warm once and reproduce exact source-value brushes", async ({
  page,
  context,
}) => {
  await loadParallelBenchmark(page, { rows: 1000, columns: 2, discrete: false, seed: 20261109 });
  await context.setOffline(true);
  const result = await page.evaluate(async () => {
    interface Plot {
      brushMasks: () => BrushMasks;
      props: { rows_filtered: Datapoint[] };
      state: { dimensions: string[] };
    }
    const plot = (
      window as unknown as { __parallelProbe: { instance: { parallelPlot: () => Plot } } }
    ).__parallelProbe.instance.parallelPlot();
    const masks = plot.brushMasks();
    const dimension = plot.state.dimensions[0];
    const ranges = (minimum: number, maximum: number): AxisSelection => [
      { col: dimension, type: "numeric" as ParamType.NUMERIC, min: minimum, max: maximum },
    ];
    const selections = (minimum: number, maximum: number) =>
      new Map([[dimension, ranges(minimum, maximum)]]);
    const post = Worker.prototype.postMessage;
    let jobs = 0;
    Worker.prototype.postMessage = function (
      this: Worker,
      ...args: Parameters<Worker["postMessage"]>
    ) {
      jobs += 1;
      post.apply(this, args);
    } as Worker["postMessage"];
    try {
      await masks.prepare(selections(0.125, 0.625));
      const afterWarmup = jobs;
      let differences = 0;
      let changed = 0;
      let previous = new Uint8Array(plot.props.rows_filtered.length);
      for (let step = 0; step < 40; ++step) {
        const minimum = 0.1 + step / 200;
        const maximum = 0.6 + step / 200;
        const actual = masks.select(selections(minimum, maximum));
        for (let row = 0; row < actual.length; ++row) {
          const value = Number(plot.props.rows_filtered[row][dimension]);
          differences += Number(actual[row] !== Number(minimum <= value && value <= maximum));
          changed += Number(actual[row] !== previous[row]);
        }
        previous = actual.slice();
      }
      await masks.prepare(selections(0.3, 0.8));
      return { afterWarmup, jobs, differences, changed };
    } finally {
      Worker.prototype.postMessage = post;
    }
  });
  expect(result.afterWarmup).toBe(1);
  expect(result.jobs).toBe(1);
  expect(result.differences).toBe(0);
  expect(result.changed).toBeGreaterThan(500);
});
