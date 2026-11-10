/** Node drives Playwright here: Bun's browser pipe is not supported on Windows. */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Page } from "@playwright/test";
import type { HiPlot } from "../src/component";
import type { HiPlotRenderOptions } from "../src/hiplot_web";
import type { LineFrame, WebGLLineRenderer } from "../src/parallel/webgl";
import type { HiPlotExperiment } from "../src/types";
import { withDeadline } from "./deadline";
import { type ParallelBenchmarkConfig, parallelExperiment, quantile } from "./parallel_data";

interface Sample {
  stage: string;
  milliseconds: number;
}
interface ProbeRenderer extends Pick<WebGLLineRenderer, "draw" | "setSelection" | "busy"> {
  gl: WebGL2RenderingContext;
  slotsFor: (columns: readonly Float32Array[]) => number[];
  present: (pixels: Uint8ClampedArray, width: number, height: number) => void;
}
interface BinnedProbe {
  binned: {
    busy: boolean;
    draw: (...args: unknown[]) => void;
  } | null;
  binnedFrame: number;
  binnedMetrics: { milliseconds: number; countMs: number; rasterMs: number } | null;
  binnedMode: () => boolean;
}
type ProbePlot = Pick<NonNullable<ReturnType<HiPlot["parallelPlot"]>>, "state" | "h"> & {
  startBrushGesture: (event: { sourceEvent: { target: Element }; y: number }, axis: string) => void;
  continueBrushGesture: (y: number) => void;
  endBrushGesture: () => void;
};
interface ProbeWindow {
  hiplot: { render: (element: HTMLElement, options: HiPlotRenderOptions) => HiPlot };
  __parallelData: (config: ParallelBenchmarkConfig) => HiPlotExperiment;
  __parallelProbe: {
    instance: HiPlot;
    samples: Sample[];
    pending: number;
    draws: number;
    loadStart: number;
    generateMs: number;
    brushInputAt: number | null;
    lastFrame: LineFrame | null;
    axisGesture?: { x: number; y: number; span: number; dimension: string };
  };
}

export const SWIFTSHADER_FLAGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--enable-gpu-rasterization",
];

/** Public render API, seeded column-major payload, and only the parallel display. */
export async function loadParallelBenchmark(
  page: Page,
  config: ParallelBenchmarkConfig,
  quality: "full" | "low" | "auto" = "full",
  onStage: (stage: string) => void = () => {},
): Promise<{
  generateMs: number;
  firstFrameMs: number;
  renderer: string;
  renderMode: "binned" | "exact";
}> {
  onStage("navigation and bundle setup");
  await page.route("http://hiplot.benchmark/**", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="plot"></div>' }),
  );
  await page.goto(
    `http://hiplot.benchmark/?hip.PARALLEL_PLOT.renderQuality=${encodeURIComponent(JSON.stringify(quality))}`,
  );
  await page.addScriptTag({ path: path.resolve("hiplot/static/built/hiplot.bundle.js") });
  await page.addScriptTag({ content: `window.__parallelData = ${parallelExperiment.toString()};` });
  onStage("payload generation and render setup");
  await page.evaluate((config) => {
    const win = window as unknown as ProbeWindow;
    const start = performance.now();
    const experiment = win.__parallelData(config);
    const generateMs = performance.now() - start;
    const element = document.getElementById("plot");
    if (element === null) {
      throw new Error("Benchmark mount point is missing");
    }
    let shuffleSeed = (config.seed ^ 0x9e3779b9) >>> 0;
    Math.random = () => {
      shuffleSeed = (Math.imul(shuffleSeed, 1664525) + 1013904223) >>> 0;
      return shuffleSeed / 4294967296;
    };
    const loadStart = performance.now();
    const instance = win.hiplot.render(element, {
      experiment,
      dataProviderName: "none",
      dark: false,
    });
    win.__parallelProbe = {
      instance,
      samples: [],
      pending: 0,
      draws: 0,
      generateMs,
      loadStart,
      brushInputAt: null,
      lastFrame: null,
    };
  }, config);
  onStage("loading/inference and first completed image");
  await page.waitForFunction(
    () => {
      const failure = document.querySelector(".alert-danger");
      if (failure !== null) {
        throw new Error(failure.textContent ?? "Parallel display failed");
      }
      const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
      if (pp?.webgl === null || pp?.webgl === undefined) {
        return false;
      }
      const binned = pp as unknown as BinnedProbe;
      return (
        !pp.webgl.busy && (!binned.binnedMode() || (binned.binnedFrame > 0 && !binned.binned?.busy))
      );
    },
    undefined,
    { timeout: 240_000, polling: 10 },
  );
  return page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).__parallelProbe;
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const pp = probe.instance.parallelPlot() as unknown as BinnedProbe;
    return {
      generateMs: probe.generateMs,
      firstFrameMs: performance.now() - probe.loadStart,
      renderer: gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unavailable",
      renderMode: pp.binnedMode() ? ("binned" as const) : ("exact" as const),
    };
  });
}

/** Outside-bundle wrappers; production builds contain no benchmark branches. */
export async function instrumentParallelBenchmark(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).__parallelProbe;
    const pp = probe.instance.parallelPlot();
    if (pp?.webgl === null || pp?.webgl === undefined) {
      throw new Error("Benchmark requires WebGL2");
    }
    const timed =
      <Args extends unknown[], Result>(
        stage: string,
        fn: (...args: Args) => Result,
      ): ((...args: Args) => Result) =>
      (...args) => {
        const start = performance.now();
        const result = fn(...args);
        probe.samples.push({ stage, milliseconds: performance.now() - start });
        return result;
      };
    if (pp.pplot === null) {
      throw new Error("No brush driver");
    }
    const gestures = pp as unknown as ProbePlot;
    const startBrush = gestures.startBrushGesture.bind(gestures);
    gestures.startBrushGesture = (event, axis) => {
      probe.brushInputAt = performance.now();
      startBrush(event, axis);
    };
    const continueBrush = gestures.continueBrushGesture.bind(gestures);
    gestures.continueBrushGesture = (y) => {
      probe.brushInputAt = performance.now();
      continueBrush(y);
    };
    const endBrush = gestures.endBrushGesture.bind(gestures);
    gestures.endBrushGesture = () => {
      probe.brushInputAt = null;
      endBrush();
    };
    const brush = timed("brushCpu", pp.pplot.brush.bind(pp.pplot));
    pp.pplot.brush = (...args) => {
      if (probe.brushInputAt !== null)
        probe.samples.push({
          stage: "brushQueue",
          milliseconds: performance.now() - probe.brushInputAt,
        });
      return brush(...args);
    };
    const masks = pp.brushMasks();
    masks.select = timed("filter", masks.select.bind(masks));
    masks.selectedRows = timed("materialize", masks.selectedRows.bind(masks));
    pp.selectionMask = timed("selectionMask", pp.selectionMask.bind(pp));
    const geometry = pp.geometry();
    geometry.pixels = timed("geometry", geometry.pixels.bind(geometry));
    geometry.colorBins = timed("colors", geometry.colorBins.bind(geometry));
    const renderer = pp.webgl as unknown as ProbeRenderer;
    renderer.setSelection = timed("selectionUpload", renderer.setSelection.bind(renderer));
    renderer.slotsFor = timed("geometryUpload", renderer.slotsFor.bind(renderer));
    const fenceFrame = (
      submittedAt: number,
      requestedAt = submittedAt,
      inputAt = probe.brushInputAt,
    ): void => {
      const gl = renderer.gl;
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (fence === null) {
        throw new Error("Could not fence benchmark frame");
      }
      gl.flush();
      probe.pending += 1;
      const poll = (): void => {
        if (gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) {
          setTimeout(poll, 0);
          return;
        }
        gl.deleteSync(fence);
        probe.pending -= 1;
        const finishedAt = performance.now();
        probe.samples.push(
          { stage: "fence", milliseconds: finishedAt - submittedAt },
          { stage: "completedFrame", milliseconds: finishedAt - requestedAt },
        );
        if (inputAt !== null)
          probe.samples.push({ stage: "inputToVisible", milliseconds: finishedAt - inputAt });
      };
      setTimeout(poll, 0);
    };
    const draw = renderer.draw.bind(renderer);
    renderer.draw = (frame) => {
      probe.lastFrame = frame;
      probe.draws += 1;
      const start = performance.now();
      draw(frame);
      probe.samples.push({ stage: "submit", milliseconds: performance.now() - start });
      fenceFrame(start);
    };
    const binned = pp as unknown as BinnedProbe;
    if (binned.binned !== null) {
      let requestedAt = performance.now();
      let requestedInputAt: number | null = null;
      const request = binned.binned.draw.bind(binned.binned);
      binned.binned.draw = (...args) => {
        requestedAt = performance.now();
        requestedInputAt = probe.brushInputAt;
        if (requestedInputAt !== null)
          probe.samples.push({
            stage: "inputToRequest",
            milliseconds: requestedAt - requestedInputAt,
          });
        request(...args);
        probe.samples.push({
          stage: "binnedSubmit",
          milliseconds: performance.now() - requestedAt,
        });
      };
      const present = renderer.present.bind(renderer);
      renderer.present = (pixels, width, height) => {
        const start = performance.now();
        const metrics = binned.binnedMetrics;
        if (metrics === null) {
          throw new Error("Binned presentation has no worker metrics");
        }
        probe.samples.push(
          { stage: "worker", milliseconds: metrics.milliseconds },
          { stage: "histogram", milliseconds: metrics.countMs },
          { stage: "raster", milliseconds: metrics.rasterMs },
          { stage: "workerLatency", milliseconds: start - requestedAt },
        );
        probe.draws += 1;
        present(pixels, width, height);
        probe.samples.push({ stage: "submit", milliseconds: performance.now() - start });
        fenceFrame(start, requestedAt, requestedInputAt);
      };
    }
  });
}

async function settle(page: Page): Promise<void> {
  const ready = (): boolean => {
    const probe = (window as unknown as ProbeWindow).__parallelProbe;
    const pp = probe.instance.parallelPlot();
    if (pp?.webgl === null || pp?.webgl === undefined) {
      return false;
    }
    const binned = pp as unknown as BinnedProbe;
    const callbacks = pp as unknown as {
      scrollSettle: unknown;
      scrollFrame: number | null;
      brushMoveFrame: number | null;
      idleRedraw: number | null;
    };
    return (
      probe.pending === 0 &&
      !pp.webgl.busy &&
      !binned.binned?.busy &&
      (!binned.binnedMode() || binned.binnedFrame > 0) &&
      callbacks.scrollSettle === null &&
      callbacks.scrollFrame === null &&
      callbacks.brushMoveFrame === null &&
      callbacks.idleRedraw === null
    );
  };
  await page.waitForFunction(ready, undefined, { timeout: 240_000, polling: 10 });
  // Queued React/brush/scroll callbacks can submit another asynchronous worker job.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.waitForFunction(ready, undefined, { timeout: 240_000, polling: 10 });
}

async function takeSamples(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).__parallelProbe;
    return probe.samples.splice(0);
  });
}

export async function measureParallelBenchmark(page: Page, steps: number) {
  await instrumentParallelBenchmark(page);
  // A warmed, full-quality redraw before gestures; also captures the exact frame.
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot()?.redrawLines();
  });
  await settle(page);
  const full = await takeSamples(page);
  await page.evaluate(() => {
    const pp = (
      window as unknown as ProbeWindow
    ).__parallelProbe.instance.parallelPlot() as unknown as ProbePlot;
    const dimension = pp.state.dimensions[1];
    const target = Array.from(document.querySelectorAll<SVGGElement>("g.dimension"))
      .find((node) => (node as SVGGElement & { __data__: string }).__data__ === dimension)
      ?.querySelector(".overlay");
    if (!target) {
      throw new Error("No benchmark brush overlay");
    }
    pp.startBrushGesture({ sourceEvent: { target }, y: pp.h * 0.2 }, dimension);
  });
  for (let step = 0; step < steps; ++step) {
    await page.evaluate(
      ({ step, steps }) => {
        const pp = (
          window as unknown as ProbeWindow
        ).__parallelProbe.instance.parallelPlot() as unknown as ProbePlot;
        pp.continueBrushGesture(pp.h * (0.35 + (0.3 * step) / Math.max(1, steps - 1)));
      },
      { step, steps },
    );
    await settle(page);
  }
  const brush = await takeSamples(page);
  await page.evaluate(() => {
    const pp = (
      window as unknown as ProbeWindow
    ).__parallelProbe.instance.parallelPlot() as unknown as ProbePlot;
    pp.endBrushGesture();
  });
  await settle(page);
  const release = await takeSamples(page);
  // The real d3 handlers move the SVG and reorder axes when neighbors cross.
  await page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).__parallelProbe;
    const pp = probe.instance.parallelPlot();
    if (!pp) {
      throw new Error("No benchmark plot");
    }
    const dimension = pp.state.dimensions[1];
    const label = document.querySelector(`[data-dimension="${dimension}"].pplot-label`);
    if (!label) {
      throw new Error("No benchmark axis label");
    }
    const box = label.getBoundingClientRect();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    probe.axisGesture = {
      x,
      y,
      dimension,
      span: pp.xPosition(pp.state.dimensions[2]) - pp.xPosition(dimension),
    };
    label.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        view: window,
        clientX: x,
        clientY: y,
        buttons: 1,
      }),
    );
  });
  await settle(page);
  for (let step = 0; step < steps; ++step) {
    await page.evaluate((step) => {
      const probe = (window as unknown as ProbeWindow).__parallelProbe;
      const gesture = probe.axisGesture;
      if (!gesture) {
        throw new Error("Axis gesture did not start");
      }
      const start = performance.now();
      window.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          view: window,
          buttons: 1,
          clientX: gesture.x + (step % 2 === 0 ? 1.2 * gesture.span : 0),
          clientY: gesture.y,
        }),
      );
      probe.samples.push({ stage: "axisDispatch", milliseconds: performance.now() - start });
    }, step);
    await settle(page);
  }
  const axis = await takeSamples(page);
  if (!axis.some((sample) => sample.stage === "fence")) {
    throw new Error("Axis benchmark did not redraw lines");
  }
  await page.evaluate(() => {
    const gesture = (window as unknown as ProbeWindow).__parallelProbe.axisGesture;
    window.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        view: window,
        clientX: gesture?.x,
        clientY: gesture?.y,
      }),
    );
  });
  await settle(page);
  // Narrow the viewport for scrolling so even eight-value integer axes overflow.
  await page.setViewportSize({ width: 360, height: 700 });
  await page.waitForFunction(() => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    return (
      pp !== null &&
      pp.state.width < 400 &&
      pp.scroller_ref.current !== null &&
      pp.scroller_ref.current.scrollWidth > pp.scroller_ref.current.clientWidth
    );
  });
  await settle(page);
  await takeSamples(page);
  for (let step = 0; step < steps; ++step) {
    await page.evaluate(
      ({ step, steps }) => {
        const probe = (window as unknown as ProbeWindow).__parallelProbe;
        const pp = probe.instance.parallelPlot();
        const scroller = pp?.scroller_ref.current;
        if (!pp || !scroller || scroller.scrollWidth <= scroller.clientWidth) {
          throw new Error("Benchmark must overflow horizontally");
        }
        const start = performance.now();
        scroller.scrollLeft = ((scroller.scrollWidth - scroller.clientWidth) * (step + 1)) / steps;
        pp.onScroll();
        probe.samples.push({ stage: "scrollCpu", milliseconds: performance.now() - start });
      },
      { step, steps },
    );
    await settle(page);
  }
  const scroll = await takeSamples(page);
  return { full, brush, release, axis, scroll };
}

function summarize(samples: Sample[]) {
  return Object.fromEntries(
    [...new Set(samples.map((sample) => sample.stage))].map((stage) => {
      const values = samples
        .filter((sample) => sample.stage === stage)
        .map((sample) => sample.milliseconds);
      return [
        stage,
        { count: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95) },
      ];
    }),
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      rows: { type: "string", default: "1000000" },
      columns: { type: "string", default: "10" },
      steps: { type: "string", default: "8" },
      reps: { type: "string", default: "3" },
      backend: { type: "string", default: "swiftshader" },
      quality: { type: "string", default: "full" },
      out: { type: "string" },
      label: { type: "string", default: "baseline" },
      "timeout-ms": { type: "string", default: "180000" },
    },
  });
  const [rows, columns, steps, reps] = [values.rows, values.columns, values.steps, values.reps].map(
    (value) => Number(value),
  );
  if (![rows, columns, steps, reps].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Rows, columns, steps, and reps must be positive integers");
  }
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Attempt timeout must be a positive integer in milliseconds");
  }
  if (values.backend !== "swiftshader" && values.backend !== "hardware") {
    throw new Error("Backend must be swiftshader or hardware");
  }
  const quality = values.quality;
  if (quality !== "full" && quality !== "low" && quality !== "auto") {
    throw new Error("Quality must be full, low, or auto");
  }
  const server = await chromium.launchServer({
    ...(values.backend === "hardware" ? { channel: "chromium" } : {}),
    args: [
      "--js-flags=--max-old-space-size=8192",
      ...(values.backend === "swiftshader"
        ? SWIFTSHADER_FLAGS
        : ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"]),
    ],
  });
  const browser = await chromium.connect(server.wsEndpoint());
  const runs = [];
  try {
    attempts: for (const discrete of [false, true]) {
      for (let rep = 0; rep < reps; ++rep) {
        const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
        const page = await context.newPage();
        const attemptStart = performance.now();
        const pageErrors: string[] = [];
        let stage = "starting";
        let crashed = false;
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("crash", () => {
          crashed = true;
        });
        try {
          const result = await withDeadline(
            async () => {
              const load = await loadParallelBenchmark(
                page,
                { rows, columns, discrete, seed: 20261109 },
                quality,
                (next) => {
                  stage = next;
                },
              );
              stage = "gesture measurements";
              process.stderr.write(
                `${values.backend} ${discrete ? "integer" : "continuous"} loaded in ${load.firstFrameMs.toFixed(0)} ms\n`,
              );
              const samples = await measureParallelBenchmark(page, steps);
              if (pageErrors.length > 0) {
                throw new Error(pageErrors.join("\n"));
              }
              const summary = Object.fromEntries(
                Object.entries(samples).map(([name, samples]) => [name, summarize(samples)]),
              );
              return { discrete, rep, ...load, summary, samples };
            },
            timeoutMs,
            () =>
              `Parallel benchmark (${rows} rows, ${discrete ? "integer" : "continuous"}), last stage: ${stage}`,
            () => server.kill(),
          );
          runs.push(result);
          console.log(JSON.stringify({ ...result, samples: undefined }));
        } catch (error) {
          const result = {
            discrete,
            rep,
            elapsedMs: performance.now() - attemptStart,
            stage,
            crashed,
            error: crashed
              ? `Browser page crashed during ${stage}`
              : error instanceof Error
                ? error.message
                : String(error),
          };
          runs.push(result);
          console.log(JSON.stringify(result));
          process.exitCode = 1;
        } finally {
          await context.close();
          if (values.out !== undefined) {
            writeFileSync(
              values.out,
              JSON.stringify({ label: values.label, rows, columns, steps, quality, runs }, null, 2),
            );
          }
        }
        if (!browser.isConnected()) break attempts;
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
