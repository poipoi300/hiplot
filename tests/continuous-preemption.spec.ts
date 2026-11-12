import { loadParallelBenchmark } from "../bench/parallel";
import type { ContinuousImage } from "../src/parallel/continuous_types";
import type { ContinuousRenderer } from "../src/parallel/continuous_worker";
import type { LineColors, LineFrame } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";
import { warmParallelWorker } from "./plot";

interface PreemptionWindow {
  __parallelProbe: {
    instance: {
      parallelPlot: () => {
        continuous: ContinuousRenderer;
        continuousFrame: number;
        continuousMetrics: ContinuousImage;
        geometry: () => never;
        selectionMask: (geometry: never) => Uint8Array;
        lineColors: (geometry: never) => LineColors;
        lineFrame: (geometry: never, mask: Uint8Array) => LineFrame;
        curvedLines: () => boolean;
      };
    };
  };
}
interface WorkerEvents {
  events: { kind: "request" | "image"; id: number; draft?: boolean }[];
  onmessage: ((event: MessageEvent<{ id: number; draft: boolean }>) => Promise<void>) | null;
  postMessage: (message: { id: number }, transfer: Transferable[]) => void;
}

test("a real new gesture overtakes release refinement before its image is published", async ({
  page,
}) => {
  await loadParallelBenchmark(
    page,
    { rows: 4096, columns: 6, discrete: false, seed: 20261109 },
    "low",
  );
  await warmParallelWorker(page);
  const worker = page.workers()[0];
  await worker.evaluate(() => {
    const scope = self as unknown as WorkerEvents;
    scope.events = [];
    const receive = scope.onmessage;
    if (receive === null) throw new Error("Missing production worker entry");
    scope.onmessage = async (event) => {
      scope.events.push({ kind: "request", id: event.data.id, draft: event.data.draft });
      await receive(event);
    };
    const post = scope.postMessage.bind(scope);
    scope.postMessage = (message, transfer) => {
      scope.events.push({ kind: "image", id: message.id });
      post(message, transfer);
    };
  });
  const before = await page.evaluate(() => {
    const plot = (window as unknown as PreemptionWindow).__parallelProbe.instance.parallelPlot();
    const geometry = plot.geometry();
    const mask = plot.selectionMask(geometry).slice();
    const colors = plot.lineColors(geometry);
    const frame = { ...plot.lineFrame(geometry, mask), curved: !plot.curvedLines(), draft: false };
    plot.continuous.draw(frame, colors, mask);
    mask[0] = 0;
    plot.continuous.draw({ ...frame, draft: true }, colors, mask);
    return plot.continuousFrame;
  });
  await page.waitForFunction((before) => {
    const plot = (window as unknown as PreemptionWindow).__parallelProbe.instance.parallelPlot();
    return plot.continuousFrame > before && !plot.continuous.busy;
  }, before);
  const events = await worker.evaluate(() => (self as unknown as WorkerEvents).events);
  const requests = events.filter((event) => event.kind === "request");
  const images = events.filter((event) => event.kind === "image");
  expect(requests.map((event) => event.draft)).toEqual([false, true]);
  expect(images.map((event) => event.id)).toEqual([requests[1].id]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as PreemptionWindow).__parallelProbe.instance.parallelPlot()
          .continuousMetrics.rows,
    ),
  ).toBe(4096);
});
