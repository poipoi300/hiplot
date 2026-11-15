import { loadParallelBenchmark } from "../bench/parallel";
import type { BrushSelection } from "../src/parallel/brush_selection";
import type { BrushMessage } from "../src/parallel/brush_types";
import type { AxisSelection } from "../src/parallel/selection";
import type { Datapoint, ParamType } from "../src/types";
import { expect, test } from "./fixtures";

test("offline brush selections read each column once and reproduce exact source-value brushes", async ({
  page,
  context,
}) => {
  await loadParallelBenchmark(page, { rows: 1000, columns: 2, discrete: false, seed: 20261109 });
  await context.setOffline(true);
  const result = await page.evaluate(async () => {
    interface Plot {
      brushSelection: () => BrushSelection;
      props: { rows_filtered: Datapoint[] };
      state: { dimensions: string[] };
    }
    const plot = (
      window as unknown as { __parallelProbe: { instance: { parallelPlot: () => Plot } } }
    ).__parallelProbe.instance.parallelPlot();
    const masks = plot.brushSelection();
    const dimension = plot.state.dimensions[0];
    const ranges = (minimum: number, maximum: number): AxisSelection => [
      { col: dimension, type: "numeric" as ParamType.NUMERIC, min: minimum, max: maximum },
    ];
    const selections = (minimum: number, maximum: number) =>
      new Map([[dimension, ranges(minimum, maximum)]]);
    // The brush worker sorts each column it is sent once; brushes then send only ranges.
    const post = Worker.prototype.postMessage;
    let columns = 0;
    Worker.prototype.postMessage = function (
      this: Worker,
      ...args: Parameters<Worker["postMessage"]>
    ) {
      if ((args[0] as Partial<BrushMessage> | null)?.kind === "column") columns += 1;
      post.apply(this, args);
    } as Worker["postMessage"];
    try {
      await masks.prepare(selections(0.125, 0.625));
      const afterWarmup = columns;
      let differences = 0;
      let changed = 0;
      let previous: Uint8Array = new Uint8Array(plot.props.rows_filtered.length);
      for (let step = 0; step < 40; ++step) {
        const minimum = 0.1 + step / 200;
        const maximum = 0.6 + step / 200;
        const selected = await masks.select(selections(minimum, maximum), null, false);
        if (selected === null) throw new Error(`A newer selection replaced step ${step}`);
        const actual = selected.mask;
        for (let row = 0; row < actual.length; ++row) {
          const value = Number(plot.props.rows_filtered[row][dimension]);
          differences += Number(actual[row] !== Number(minimum <= value && value <= maximum));
          changed += Number(actual[row] !== previous[row]);
        }
        previous = actual;
      }
      await masks.prepare(selections(0.3, 0.8));
      return { afterWarmup, columns, differences, changed };
    } finally {
      Worker.prototype.postMessage = post;
    }
  });
  expect(result.afterWarmup).toBe(1);
  expect(result.columns).toBe(1);
  expect(result.differences).toBe(0);
  expect(result.changed).toBeGreaterThan(500);
});
