import { expect, test } from "bun:test";
import { BatchSize, type LineBatch, type LineFrame, WebGLLineRenderer } from "./webgl";

const frame: LineFrame = {
  axes: [],
  width: 10,
  height: 8,
  pixelRatio: 2,
  lineWidth: 1,
  curved: false,
  draft: false,
  transient: false,
  resolution: 1,
  drawnRows: 3,
  selectedCount: 2,
  contextCount: 1,
  contextColor: { r: 1, g: 2, b: 3 },
  contextAlpha: 0.2,
  colorMode: "highest",
};

test("a batch size scales a full batch's own rows toward 6 ms, at most twofold, within 1 and 32768", () => {
  const size = new BatchSize(5);
  const full = (rows: number) => ({ size, rows, drawn: rows, full: true });
  size.adapt(full(100), 0.1);
  expect(size.rows).toBe(200);
  size.adapt(full(100), 12);
  expect(size.rows).toBe(50);
  size.adapt(full(1000), 6);
  expect(size.rows).toBe(1000);
  size.adapt(full(100), 6000);
  expect(size.rows).toBe(1);
  size.adapt(full(30000), 1);
  expect(size.rows).toBe(32768);
  // Fewer rows of every segment than asked, by rounding a shorter run's rows: still full.
  size.adapt({ size, rows: 15, drawn: 14.999999999999998, full: true }, 3);
  expect(size.rows).toBe(30);
});

test("a short batch shrinks its size only when it overran 6 ms", () => {
  const size = new BatchSize(1000);
  const short = (drawn: number) => ({ size, rows: 1000, drawn, full: false });
  size.adapt(short(10), 1);
  expect(size.rows).toBe(1000);
  size.adapt(short(300), 12);
  expect(size.rows).toBe(150);
  // Never grows from a short batch, however fast.
  size.adapt(short(900), 6.5);
  expect(size.rows).toBe(150);
});

test("cooperative batches keep one queued, adapt every sized batch including the last, and release failed fences", async () => {
  for (const failure of [null, "context", "fence"] as const) {
    let signaled = false,
      deleted = 0,
      batches = 0;
    const lines = new BatchSize(128);
    const strips = new BatchSize(64);
    const adapted: [BatchSize, LineBatch][] = [];
    for (const size of [lines, strips]) {
      size.adapt = (batch) => {
        adapted.push([size, batch]);
      };
    }
    // Two kinds of draws, unsized work between them, and a short batch at the end of a range.
    const submitted: LineBatch[] = [
      { size: lines, rows: 128, drawn: 128, full: true },
      { size: null, rows: 0, drawn: 0, full: true },
      { size: strips, rows: 64, drawn: 64, full: true },
      { size: lines, rows: 256, drawn: 10, full: false },
      { size: lines, rows: 256, drawn: 256, full: true },
    ];
    const renderer = Object.create(WebGLLineRenderer.prototype) as WebGLLineRenderer;
    Object.assign(renderer, {
      softwareRendering: failure === null,
      blocks: null,
      gl: {
        SYNC_GPU_COMMANDS_COMPLETE: 1,
        SYNC_STATUS: 2,
        SIGNALED: 3,
        fenceSync: () => (failure === "fence" ? null : {}),
        flush() {},
        isContextLost: () => failure === "context",
        getSyncParameter: () => {
          signaled = !signaled;
          return signaled ? 0 : 3;
        },
        deleteSync: () => {
          deleted++;
        },
      },
      *drawFrame(_frame: LineFrame, batched: boolean) {
        expect(batched).toBe(true);
        for (const [i, batch] of submitted.entries()) {
          // One batch stays queued behind the one in flight.
          expect(deleted).toBe(Math.max(0, i - 1));
          batches++;
          yield batch;
        }
      },
    });
    const work = renderer.drawCooperative(frame);
    if (failure === null) {
      await work;
      expect(batches).toBe(5);
      expect(deleted).toBe(5);
      expect(adapted).toEqual([
        [lines, submitted[0]],
        [strips, submitted[2]],
        [lines, submitted[3]],
        [lines, submitted[4]],
      ]);
    } else {
      await expect(work).rejects.toThrow(failure === "context" ? "lost" : "fence");
      // A lost context releases the awaited fence and the one queued behind it.
      expect(deleted).toBe(failure === "context" ? 2 : 0);
    }
  }
});
