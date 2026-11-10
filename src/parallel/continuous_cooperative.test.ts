import { expect, test } from "bun:test";
import { ContinuousDensityEvaluator } from "./continuous_density";
import { ContinuousKernel } from "./continuous_grid";
import type { ContinuousRequest } from "./continuous_types";

test("obsolete refinement yields after one pair and the next image uses current grids", async () => {
  const request: ContinuousRequest = {
    id: 1,
    width: 48,
    height: 8,
    lineWidth: 1,
    pixelRatio: 1,
    curved: false,
    draft: false,
    resolution: 1,
    drawnRows: 3,
    selectedCount: 3,
    contextCount: 0,
    contextColor: { r: 0, g: 255, b: 0 },
    contextAlpha: 0,
    colorMode: "mean",
    axes: [1, 2, 3].map((column) => ({ column, x: (column - 1) * 16 })),
    columns: [1, 2, 3].map((id) => ({ id, pixels: new Float32Array([2, 4, 6]) })),
    colors: { bins: new Uint32Array(3), palette: [{ r: 255, g: 0, b: 0 }], colorMapBins: 0 },
    selection: new Uint8Array([1, 1, 1]),
  };
  const kernel = new ContinuousKernel();
  const evaluator = new ContinuousDensityEvaluator({ gl: null });
  const update = kernel.update(request);
  let current = true;
  const refinement = evaluator.renderCooperative(request, update, () => current);
  current = false;
  expect(await refinement).toBeNull();
  expect(evaluator.render(request, update).evaluatedPairs).toBe(update.pairs.length - 1);
  const next = {
    ...request,
    id: 2,
    columns: [],
    colors: undefined,
    selection: new Uint8Array([0, 1, 0]),
    draft: true,
  };
  const changed = kernel.update(next);
  const image = evaluator.render(next, changed);
  const fresh = new ContinuousDensityEvaluator({ gl: null });
  expect(image.pixels).toEqual(fresh.render(next, changed).pixels);
  expect(image.pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
  evaluator.dispose();
  fresh.dispose();
});
