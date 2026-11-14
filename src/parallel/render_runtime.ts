import { ContinuousRuntime } from "./continuous_runtime";
import type { ContinuousRequest } from "./continuous_types";
import type { ContinuousMetrics, RenderMessage, RenderReply, RenderRequest } from "./render_types";
import { type LineColors, type LineFocus, TaskPoller, WebGLLineRenderer } from "./webgl";

export interface RenderWorkerScope {
  onmessage: ((event: MessageEvent<RenderMessage>) => void) | null;
  postMessage: (reply: RenderReply, transfer: Transferable[]) => void;
}

/** What the worker draws with on its canvas. */
export type CanvasRenderer = Pick<
  WebGLLineRenderer,
  | "densityRendering"
  | "softwareRendering"
  | "setRows"
  | "setDrawOrder"
  | "setColors"
  | "setSelection"
  | "drawCooperative"
  | "present"
  | "busy"
  | "contextLost"
  | "finishedFrame"
>;

export type ContinuousEvaluation = Pick<
  ContinuousRuntime,
  "render" | "renderCooperative" | "dispose"
>;

/**
 * The plot's one renderer: it holds the latest state the page posted and
 * draws it, exact lines or continuous density, on the canvas the page
 * transferred, which shows every finished frame without the page. Requests
 * arriving during a frame only update that state, so the next frame draws the
 * newest and the page never waits for one. Exact frames always finish; a
 * continuous refinement gives way to a gesture's draft or another mode.
 */
export function connectRenderWorker(
  scope: RenderWorkerScope,
  createRenderer: (canvas: OffscreenCanvas) => CanvasRenderer | null = (canvas) =>
    WebGLLineRenderer.create(canvas, true),
  createContinuous: () => ContinuousEvaluation = () => new ContinuousRuntime(),
): void {
  let initialized = false;
  let failed = false;
  let renderer: CanvasRenderer | null = null;
  // The latest of every delta; the columns of the latest request's axes.
  let columns = new Map<number, Float32Array>();
  let colors: LineColors | null = null;
  let order: Uint32Array | null = null;
  let drawOrder: Uint32Array | null = null;
  let selection: Uint8Array | null = null;
  let focusRows: Uint8Array | null = null;
  /** Replaced selections, returned with the next frame, once no frame uses them. */
  let released: Uint8Array[] = [];
  let latest: RenderRequest | null = null;
  let running = false;
  let drawing: { mode: RenderRequest["mode"]; draft: boolean } | null = null;
  let generation = 0;
  // What the continuous kernel holds, to send it only what changed (see ContinuousKernel).
  let continuous: ContinuousEvaluation | null = null;
  let kernelColumns = new Set<number>();
  let kernelColors: LineColors | null = null;
  let kernelSelection: Uint8Array | null = null;

  const fail = (error: unknown): void => {
    failed = true;
    latest = null;
    scope.postMessage(
      { kind: "error", message: error instanceof Error ? error.message : String(error) },
      [],
    );
  };

  const apply = (request: RenderRequest): void => {
    colors = request.colors ?? colors;
    order = request.order ?? order;
    drawOrder = request.drawOrder ?? drawOrder;
    focusRows = request.focus?.rows ?? focusRows;
    if (request.selection !== undefined) {
      if (selection !== null) released.push(selection);
      selection = request.selection;
    }
    for (const column of request.columns) columns.set(column.id, column.pixels);
    const retained = new Map<number, Float32Array>();
    for (const axis of request.axes) {
      const pixels = columns.get(axis.column);
      if (pixels === undefined) throw new Error(`Missing render worker column ${axis.column}`);
      retained.set(axis.column, pixels);
    }
    columns = retained;
  };

  const settle = async (canvasRenderer: CanvasRenderer) => {
    const poller = new TaskPoller(canvasRenderer.softwareRendering);
    try {
      // A lost context's fences never signal.
      while (canvasRenderer.busy) {
        if (canvasRenderer.contextLost) throw new Error("The render worker lost its WebGL context");
        await poller.next();
      }
    } finally {
      poller.close();
    }
    const finished = canvasRenderer.finishedFrame();
    if (finished === null) throw new Error("Render worker did not finish its frame");
    return finished;
  };

  const reply = (
    request: RenderRequest,
    finished: Extract<RenderReply, { kind: "frame" }>["finished"],
    image: Awaited<ReturnType<ContinuousEvaluation["renderCooperative"]>>,
  ): void => {
    const returned = released;
    released = [];
    const transfer: Transferable[] = returned.map((buffer) => buffer.buffer);
    let metrics: ContinuousMetrics | null = null;
    let pixels: Uint8ClampedArray | null = null;
    if (image !== null) {
      const { pixels: imagePixels, ...measured } = image;
      metrics = measured;
      if (renderer === null) {
        pixels = imagePixels;
        transfer.push(imagePixels.buffer);
      }
    }
    scope.postMessage(
      {
        kind: "frame",
        id: request.id,
        mode: request.mode,
        finished,
        continuous: metrics,
        pixels,
        released: returned,
      },
      transfer,
    );
  };

  const dropContinuous = (): void => {
    continuous?.dispose();
    continuous = null;
    kernelColumns = new Set();
    kernelColors = null;
    kernelSelection = null;
  };

  const drawExact = async (request: RenderRequest): Promise<void> => {
    if (renderer === null) throw new Error("Exact lines need the worker's canvas");
    if (colors === null || order === null || drawOrder === null || selection === null) {
      throw new Error("Exact frames need rows, a draw order, colors and a selection");
    }
    // Exact lines took over: the density kernel's counts would only go stale.
    dropContinuous();
    renderer.setRows(order.length, order);
    renderer.setDrawOrder(drawOrder);
    renderer.setColors(colors);
    renderer.setSelection(selection);
    let focus: LineFocus | null = null;
    if (request.focus !== null) {
      if (focusRows === null) throw new Error("A brush focus needs its rows");
      focus = { ...request.focus, rows: focusRows };
    }
    const axes = request.axes.map((axis) => ({
      x: axis.x,
      pixels: columns.get(axis.column) as Float32Array,
    }));
    await renderer.drawCooperative({ ...request, axes }, focus);
    reply(request, await settle(renderer), null);
  };

  const drawContinuous = async (request: RenderRequest): Promise<void> => {
    if (colors === null || selection === null) {
      throw new Error("Continuous frames need colors and a selection");
    }
    continuous ??= createContinuous();
    const kernelRequest: ContinuousRequest = {
      ...request,
      columns: Array.from(columns, ([id, pixels]) => ({ id, pixels })).filter(
        ({ id }) => !kernelColumns.has(id),
      ),
      colors: colors === kernelColors ? undefined : colors,
      selection: selection === kernelSelection ? undefined : selection,
    };
    const current = generation;
    const rendering = request.draft
      ? Promise.resolve(continuous.render(kernelRequest))
      : continuous.renderCooperative(kernelRequest, () => generation === current);
    // The kernel applied every delta before rendering could yield.
    kernelColumns = new Set(request.axes.map((axis) => axis.column));
    kernelColors = colors;
    kernelSelection = selection;
    const image = await rendering;
    // A refinement superseded by a gesture or another mode: the loop draws the latest.
    if (image === null) return;
    if (renderer === null) {
      reply(request, null, image);
      return;
    }
    renderer.present(image, request);
    reply(request, await settle(renderer), image);
  };

  const run = async (): Promise<void> => {
    running = true;
    try {
      while (latest !== null && !failed) {
        const request = latest;
        latest = null;
        drawing = { mode: request.mode, draft: request.draft };
        if (request.mode === "exact") await drawExact(request);
        else await drawContinuous(request);
      }
    } catch (error) {
      fail(error);
    } finally {
      drawing = null;
      running = false;
    }
  };

  scope.onmessage = ({ data }) => {
    if (failed) return;
    try {
      if (data.kind === "init") {
        if (initialized) throw new Error("The render worker was initialized twice");
        initialized = true;
        renderer = createRenderer(data.canvas);
        const density = renderer?.densityRendering ?? false;
        scope.postMessage(
          {
            kind: "ready",
            presents: renderer !== null,
            density,
            blocks: density && renderer?.softwareRendering === false,
          },
          [],
        );
        return;
      }
      if (!initialized) throw new Error("A frame reached the render worker before its canvas");
      apply(data);
      latest = data;
      if (
        drawing !== null &&
        drawing.mode === "continuous" &&
        !drawing.draft &&
        (data.draft || data.mode !== "continuous")
      ) {
        generation += 1;
      }
      if (!running) void run();
    } catch (error) {
      fail(error);
    }
  };
}
