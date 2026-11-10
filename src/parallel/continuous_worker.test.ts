import { describe, expect, test } from "bun:test";
import type { ContinuousImage, ContinuousRequest } from "./continuous_types";
import { ContinuousRenderer } from "./continuous_worker";
import type { LineColors, LineFrame } from "./webgl";

class WorkerDouble {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly requests: ContinuousRequest[] = [];
  terminated = false;

  postMessage(request: ContinuousRequest, transfer: Transferable[]): void {
    this.requests.push(structuredClone(request, { transfer }));
  }

  terminate(): void {
    this.terminated = true;
  }

  finish(index: number): void {
    const request = this.requests[index];
    const image: ContinuousImage = {
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
    this.onmessage?.({ data: { id: request.id, image } } as MessageEvent);
  }

  asWorker(): Worker {
    return this as unknown as Worker;
  }
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

describe("single continuous worker channel", () => {
  test("transfers owned copies and retains column/color identities and unchanged masks", async () => {
    const worker = new WorkerDouble();
    const received: ContinuousImage[] = [];
    const renderer = new ContinuousRenderer(
      (image) => received.push(image),
      async () => worker.asWorker(),
    );
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    await ready();
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0].columns).toHaveLength(2);
    expect(worker.requests[0].curved).toBe(true);
    expect(worker.requests[0].colors?.bins).toEqual(colors.bins);
    expect(frame.axes[0].pixels.byteLength).toBe(8);
    expect(colors.bins.byteLength).toBe(8);
    expect(selection.byteLength).toBe(2);
    expect(renderer.busy).toBe(true);
    worker.finish(0);
    expect(renderer.busy).toBe(false);
    expect(received).toHaveLength(1);
    renderer.draw(frame, colors, selection);
    const unchanged = worker.requests[1];
    expect(unchanged.columns).toHaveLength(0);
    expect(unchanged.colors).toBeUndefined();
    expect(unchanged.selection).toBeUndefined();
    worker.finish(1);
    selection[0] = 0;
    renderer.draw(frame, colors, selection);
    expect(worker.requests[2].selection).toEqual(new Uint8Array([0, 1]));
    expect(selection.byteLength).toBe(2);
    renderer.dispose();
    expect(worker.terminated).toBe(true);
    expect(renderer.busy).toBe(false);
  });

  test("finite bursts coalesce to latest pending and reject obsolete images", async () => {
    const worker = new WorkerDouble();
    const received: ContinuousImage[] = [];
    const renderer = new ContinuousRenderer(
      (image) => received.push(image),
      async () => worker.asWorker(),
    );
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    await ready();
    renderer.draw({ ...frame, width: 20 }, colors, selection);
    renderer.draw({ ...frame, width: 30 }, colors, selection);
    expect(worker.requests).toHaveLength(1);
    worker.finish(0);
    expect(received).toHaveLength(0);
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1].width).toBe(30);
    worker.finish(1);
    expect(received).toHaveLength(1);
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });

  test("a callback can queue the next paced gesture without reporting idle early", async () => {
    const worker = new WorkerDouble();
    const { frame, colors, selection } = source();
    let accepted = 0;
    const renderer = new ContinuousRenderer(
      () => {
        expect(renderer.busy).toBe(true);
        if (++accepted === 1) renderer.draw(frame, colors, selection);
      },
      async () => worker.asWorker(),
    );
    renderer.draw(frame, colors, selection);
    await ready();
    worker.finish(0);
    expect(worker.requests).toHaveLength(2);
    expect(renderer.busy).toBe(true);
    worker.finish(1);
    expect(accepted).toBe(2);
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });

  test("pending masks and geometry positions are snapshotted before later caller mutations", async () => {
    const worker = new WorkerDouble();
    const renderer = new ContinuousRenderer(
      () => {},
      async () => worker.asWorker(),
    );
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    selection[0] = 0;
    frame.axes[0].x = -100;
    await ready();
    expect(worker.requests[0].selection).toEqual(new Uint8Array([1, 1]));
    expect(worker.requests[0].axes[0].x).toBe(0);
    renderer.dispose();
  });

  test("shared geometry identities are transferred once and refer to one column ID", async () => {
    const worker = new WorkerDouble();
    const renderer = new ContinuousRenderer(
      () => {},
      async () => worker.asWorker(),
    );
    const { frame, colors, selection } = source();
    frame.axes[1].pixels = frame.axes[0].pixels;
    renderer.draw(frame, colors, selection);
    await ready();
    expect(worker.requests[0].columns).toHaveLength(1);
    expect(worker.requests[0].axes[0].column).toBe(worker.requests[0].axes[1].column);
    renderer.dispose();
  });

  test("late worker initialization after disposal terminates without dispatch", async () => {
    const worker = new WorkerDouble();
    let resolve: ((worker: Worker) => void) | undefined;
    const initializing = new Promise<Worker>((done) => {
      resolve = done;
    });
    const renderer = new ContinuousRenderer(
      () => {},
      () => initializing,
    );
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    renderer.dispose();
    resolve?.(worker.asWorker());
    await ready();
    expect(worker.terminated).toBe(true);
    expect(worker.requests).toHaveLength(0);
    expect(() => renderer.draw(frame, colors, selection)).toThrow("disposed");
  });

  test("mismatched source lengths fail before starting a worker", () => {
    const { frame, colors } = source();
    const renderer = new ContinuousRenderer(() => {});
    expect(() => renderer.draw(frame, colors, new Uint8Array(1))).toThrow("same rows");
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });
});
