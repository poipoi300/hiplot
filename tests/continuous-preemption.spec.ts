import { loadParallelBenchmark } from "../bench/parallel";
import type { ContinuousMetrics, RenderMessage, RenderReply } from "../src/parallel/render_types";
import type { RenderWorker } from "../src/parallel/render_worker";
import type { LineColors, LineFrame } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";
import { renderWorker, warmParallelWorker } from "./plot";

interface PreemptionWindow {
  __parallelProbe: {
    instance: {
      parallelPlot: () => {
        worker: RenderWorker;
        linesBusy: boolean;
        continuousFrame: number;
        continuousMetrics: ContinuousMetrics;
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
  onmessage: ((event: MessageEvent<RenderMessage>) => void) | null;
  postMessage: (reply: RenderReply, transfer: Transferable[]) => void;
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
  const worker = await renderWorker(page);
  await worker.evaluate(() => {
    const scope = self as unknown as WorkerEvents;
    scope.events = [];
    const receive = scope.onmessage;
    if (receive === null) throw new Error("Missing production worker entry");
    scope.onmessage = (event) => {
      if (event.data.kind === "frame")
        scope.events.push({ kind: "request", id: event.data.id, draft: event.data.draft });
      receive(event);
    };
    const post = scope.postMessage.bind(scope);
    scope.postMessage = (reply, transfer) => {
      if (reply.kind === "frame") scope.events.push({ kind: "image", id: reply.id });
      post(reply, transfer);
    };
  });
  const before = await page.evaluate(async () => {
    const plot = (window as unknown as PreemptionWindow).__parallelProbe.instance.parallelPlot();
    const geometry = plot.geometry();
    const mask = plot.selectionMask(geometry).slice();
    const colors = plot.lineColors(geometry);
    const frame = { ...plot.lineFrame(geometry, mask), curved: !plot.curvedLines(), draft: false };
    plot.worker.drawContinuous(frame, colors, mask);
    // Draws requested together send only the last: the refinement is posted
    // on its own, then the gesture's draft right behind it in the same task.
    await Promise.resolve();
    mask[0] = 0;
    plot.worker.drawContinuous({ ...frame, draft: true }, colors, mask);
    return plot.continuousFrame;
  });
  await page.waitForFunction((before) => {
    const plot = (window as unknown as PreemptionWindow).__parallelProbe.instance.parallelPlot();
    return plot.continuousFrame > before && !plot.linesBusy;
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
