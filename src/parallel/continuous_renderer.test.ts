import { describe, expect, test } from "bun:test";
import { ContinuousRenderer } from "./continuous_renderer";
import { ContinuousRuntime } from "./continuous_runtime";
import type { ContinuousImage, ContinuousRequest, ContinuousUpdate } from "./continuous_types";
import type { LineColors, LineFrame } from "./webgl";

function resultImage(): ContinuousImage {
  return {
    pixels: new Uint8ClampedArray([255, 0, 0, 128]),
    width: 1,
    height: 1,
    milliseconds: 0,
    countMs: 0,
    rasterMs: 0,
    rows: 2,
    axisBins: 256,
    evaluatedColumns: 1,
    evaluatedPairs: 1,
  };
}

function source(): { frame: LineFrame; colors: LineColors; selection: Uint8Array } {
  return {
    frame: {
      axes: [
        { x: 0, pixels: new Float32Array([1, 2]) },
        { x: 16, pixels: new Float32Array([2, 3]) },
      ],
      width: 16,
      height: 8,
      lineWidth: 1,
      pixelRatio: 1,
      curved: true,
      draft: false,
      transient: false,
      resolution: 1,
      drawnRows: 2,
      selectedCount: 2,
      contextCount: 0,
      contextColor: { r: 0, g: 0, b: 0 },
      contextAlpha: 0.2,
      colorMode: "mean",
    },
    colors: { bins: new Uint32Array([0, 0]), palette: [{ r: 255, g: 0, b: 0 }], colorMapBins: 0 },
    selection: new Uint8Array([1, 1]),
  };
}

const ready = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

/** Lets resolved renders publish. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; ++i) await Promise.resolve();
};

test("page density retains deltas and publishes every row", async () => {
  const images: ContinuousImage[] = [];
  const renderer = new ContinuousRenderer((image) => images.push(image));
  const { frame, colors, selection } = source();
  const idle = async () => {
    while (renderer.busy) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  try {
    renderer.draw(frame, colors, selection);
    await idle();
    expect(images).toHaveLength(1);
    expect(images[0].rows).toBe(selection.length);
    renderer.draw(frame, colors, selection);
    await idle();
    expect(images[1].evaluatedPairs).toBe(0);
    selection[1] = 0;
    renderer.draw({ ...frame, selectedCount: 1, contextCount: 1 }, colors, selection);
    await idle();
    expect(images[2].rows).toBe(2);
    expect(images[2].evaluatedPairs).toBeGreaterThan(0);
    expect(images[2].pixels).not.toEqual(images[1].pixels);
  } finally {
    renderer.dispose();
  }
});

function request(id: number, draft = false): ContinuousRequest {
  const { frame, colors, selection } = source();
  return {
    ...frame,
    id,
    draft,
    axes: frame.axes.map((axis, index) => ({ column: index + 1, x: axis.x })),
    columns: frame.axes.map((axis, index) => ({ id: index + 1, pixels: axis.pixels })),
    colors,
    selection,
  };
}

test("cooperative validation rejects through its promise so the host can release busy", async () => {
  const runtime = new ContinuousRuntime();
  try {
    const work = runtime.renderCooperative({ ...request(1), height: Number.NaN }, () => true);
    await expect(work).rejects.toThrow("axis height");
  } finally {
    runtime.dispose();
  }
});

/** A runtime whose renders finish when the test says so, recording what each was sent. */
class RuntimeDouble {
  readonly requests: ContinuousRequest[] = [];
  readonly renders: {
    resolve: (image: ContinuousImage | null) => void;
    reject: (error: Error) => void;
  }[] = [];
  disposed = false;

  renderCooperative(sent: ContinuousRequest): Promise<ContinuousImage | null> {
    this.requests.push(sent);
    return new Promise((resolve, reject) => {
      this.renders.push({ resolve, reject });
    });
  }

  finish(index: number): void {
    this.renders[index].resolve(resultImage());
  }

  dispose(): void {
    this.disposed = true;
  }
}

function pageRenderer(
  runtime: RuntimeDouble,
  onImage: (image: ContinuousImage) => void = () => {},
): ContinuousRenderer {
  return new ContinuousRenderer(onImage, async () => runtime);
}

describe("page continuous renderer", () => {
  test("sends owned copies, retains column and color identities and skips unchanged masks", async () => {
    const runtime = new RuntimeDouble();
    const received: ContinuousImage[] = [];
    const renderer = pageRenderer(runtime, (image) => received.push(image));
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    await ready();
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0].columns).toHaveLength(2);
    expect(runtime.requests[0].curved).toBe(true);
    expect(runtime.requests[0].colors?.bins).toEqual(colors.bins);
    expect(renderer.busy).toBe(true);
    runtime.finish(0);
    await settle();
    expect(renderer.busy).toBe(false);
    expect(received).toHaveLength(1);
    renderer.draw(frame, colors, selection);
    const unchanged = runtime.requests[1];
    expect(unchanged.columns).toHaveLength(0);
    expect(unchanged.colors).toBeUndefined();
    expect(unchanged.selection).toBeUndefined();
    runtime.finish(1);
    await settle();
    selection[0] = 0;
    renderer.draw(frame, colors, selection);
    expect(runtime.requests[2].selection).toEqual(new Uint8Array([0, 1]));
    renderer.dispose();
    expect(runtime.disposed).toBe(true);
    expect(renderer.busy).toBe(false);
  });

  test("finite bursts coalesce to the latest pending frame and drop obsolete images", async () => {
    const runtime = new RuntimeDouble();
    const received: ContinuousImage[] = [];
    const renderer = pageRenderer(runtime, (image) => received.push(image));
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    await ready();
    renderer.draw({ ...frame, width: 20 }, colors, selection);
    renderer.draw({ ...frame, width: 30 }, colors, selection);
    expect(runtime.requests).toHaveLength(1);
    runtime.finish(0);
    await settle();
    expect(received).toHaveLength(0);
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[1].width).toBe(30);
    runtime.finish(1);
    await settle();
    expect(received).toHaveLength(1);
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });

  test("a new gesture dispatches before refinement completes and ignores its stale image", async () => {
    const runtime = new RuntimeDouble();
    const received: ContinuousImage[] = [];
    const renderer = pageRenderer(runtime, (image) => received.push(image));
    const { frame, colors, selection } = source();
    renderer.draw({ ...frame, draft: true }, colors, selection);
    expect(renderer.refining).toBe(false);
    await ready();
    runtime.finish(0);
    await settle();
    renderer.draw(frame, colors, selection);
    expect(runtime.requests).toHaveLength(2);
    expect(renderer.refining).toBe(true);
    selection[0] = 0;
    renderer.draw({ ...frame, draft: true }, colors, selection);
    expect(runtime.requests).toHaveLength(3);
    expect(runtime.requests[2].draft).toBe(true);
    expect(runtime.requests[2].selection).toEqual(new Uint8Array([0, 1]));
    expect(renderer.refining).toBe(false);
    runtime.finish(1);
    await settle();
    expect(received).toHaveLength(1);
    expect(renderer.busy).toBe(true);
    runtime.finish(2);
    await settle();
    expect(received).toHaveLength(2);
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });

  test("a callback can queue the next paced gesture without reporting idle early", async () => {
    const runtime = new RuntimeDouble();
    const { frame, colors, selection } = source();
    let accepted = 0;
    const renderer = pageRenderer(runtime, () => {
      expect(renderer.busy).toBe(true);
      expect(renderer.refining).toBe(false);
      if (++accepted === 1) renderer.draw({ ...frame, draft: true }, colors, selection);
    });
    renderer.draw(frame, colors, selection);
    await ready();
    runtime.finish(0);
    await settle();
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[1].draft).toBe(true);
    expect(renderer.busy).toBe(true);
    runtime.finish(1);
    await settle();
    expect(accepted).toBe(2);
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });

  test("pending masks and positions are snapshotted before later caller mutations", async () => {
    const runtime = new RuntimeDouble();
    const renderer = pageRenderer(runtime);
    const { frame, colors, selection } = source();
    frame.axes[1].pixels = frame.axes[0].pixels;
    renderer.draw(frame, colors, selection);
    selection[0] = 0;
    frame.axes[0].x = -100;
    await ready();
    expect(runtime.requests[0].selection).toEqual(new Uint8Array([1, 1]));
    expect(runtime.requests[0].axes[0].x).toBe(0);
    // Shared geometry is one column.
    expect(runtime.requests[0].columns).toHaveLength(1);
    expect(runtime.requests[0].axes[0].column).toBe(runtime.requests[0].axes[1].column);
    renderer.dispose();
  });

  test("render failures stay visible; late runtimes after disposal are released", async () => {
    const scheduled: (() => void)[] = [];
    const timer = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void) => {
      scheduled.push(callback);
      return 0;
    }) as unknown as typeof setTimeout;
    try {
      const runtime = new RuntimeDouble();
      const renderer = pageRenderer(runtime);
      const { frame, colors, selection } = source();
      renderer.draw(frame, colors, selection);
      await ready();
      runtime.renders[0].reject(new Error("raster failure"));
      await settle();
      expect(renderer.busy).toBe(false);
      expect(() => renderer.draw(frame, colors, selection)).toThrow("raster failure");
      expect(() => scheduled.shift()?.()).toThrow("raster failure");
      const failing = new ContinuousRenderer(
        () => {},
        async () => {
          throw "no runtime";
        },
      );
      failing.draw(frame, colors, selection);
      await settle();
      expect(() => failing.draw(frame, colors, selection)).toThrow("no runtime");
      expect(() => scheduled.shift()?.()).toThrow("no runtime");
    } finally {
      globalThis.setTimeout = timer;
    }
    const late = new RuntimeDouble();
    let resolve: ((runtime: RuntimeDouble) => void) | undefined;
    const renderer = new ContinuousRenderer(
      () => {},
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    renderer.dispose();
    resolve?.(late);
    await ready();
    expect(late.disposed).toBe(true);
    expect(late.requests).toHaveLength(0);
    expect(() => renderer.draw(frame, colors, selection)).toThrow("disposed");
  });

  test("mismatched source lengths fail before starting a runtime", () => {
    const { frame, colors } = source();
    const renderer = new ContinuousRenderer(() => {});
    expect(() => renderer.draw(frame, colors, new Uint8Array(1))).toThrow("same rows");
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });
});

class ControlledEvaluator {
  readonly drafts: { frame: ContinuousRequest; update: ContinuousUpdate }[] = [];
  readonly refinements: {
    frame: ContinuousRequest;
    update: ContinuousUpdate;
    resolve: (image: ContinuousImage | null) => void;
  }[] = [];

  render(frame: ContinuousRequest, update: ContinuousUpdate): ContinuousImage {
    this.drafts.push({ frame, update });
    return resultImage();
  }

  renderCooperative(
    frame: ContinuousRequest,
    update: ContinuousUpdate,
  ): Promise<ContinuousImage | null> {
    return new Promise((resolve) => {
      this.refinements.push({ frame, update, resolve });
    });
  }
}

test("the kernel applies every column, color and mask delta before rendering", async () => {
  const evaluator = new ControlledEvaluator();
  const runtime = new ContinuousRuntime(() => evaluator);
  const first = request(1);
  const firstCompletion = runtime.renderCooperative(first, () => false);
  const replacement: ContinuousRequest = {
    ...first,
    id: 2,
    axes: [{ column: 3, x: 0 }, first.axes[1]],
    columns: [{ id: 3, pixels: new Float32Array([5, 6]) }],
    colors: {
      bins: new Uint32Array([0, 1]),
      palette: [
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 0, b: 255 },
      ],
      colorMapBins: 0,
    },
    selection: new Uint8Array([0, 1]),
  };
  const replacementCompletion = runtime.renderCooperative(replacement, () => false);
  runtime.render({
    ...replacement,
    id: 3,
    draft: true,
    columns: [],
    colors: undefined,
    selection: undefined,
  });
  const update = evaluator.drafts[0].update;
  expect(update.colors).toBe(evaluator.refinements[1].update.colors);
  expect(update.colors.bins).toEqual(new Uint32Array([0, 1]));
  expect(update.colors.palette[1]).toEqual({ r: 0, g: 0, b: 255 });
  expect(update.selectedCount).toBe(1);
  expect(update.contextCount).toBe(1);
  expect(update.changedRows).toBe(0);
  expect(update.pairs.map((pair) => pair.key)).toEqual(["-1:3", "3:2", "2:-1"]);
  expect(update.pairs[1].histogram).toBe(evaluator.refinements[1].update.pairs[1].histogram);
  evaluator.refinements[0].resolve(null);
  evaluator.refinements[1].resolve(null);
  expect(await firstCompletion).toBeNull();
  expect(await replacementCompletion).toBeNull();
});
