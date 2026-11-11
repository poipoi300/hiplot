import type { ExactReply, ExactRequest } from "./exact_types";
import { type LineColors, WebGLLineRenderer } from "./webgl";

export interface ExactWorkerScope {
  onmessage: ((event: MessageEvent<ExactRequest>) => Promise<void>) | null;
  postMessage: (reply: ExactReply, transfer: Transferable[]) => void;
}

export interface ExactSurface {
  canvas: Pick<OffscreenCanvas, "width" | "height" | "transferToImageBitmap">;
  renderer: Pick<
    WebGLLineRenderer,
    | "densityRendering"
    | "setRows"
    | "setDrawOrder"
    | "setColors"
    | "setSelection"
    | "drawCooperative"
    | "busy"
    | "finishedFrame"
  >;
}

export function connectExactWorker(
  scope: ExactWorkerScope,
  createSurface: () => ExactSurface | null = () => {
    const canvas = new OffscreenCanvas(1, 1);
    const renderer = WebGLLineRenderer.create(canvas);
    return renderer === null ? null : { canvas, renderer };
  },
): void {
  const fail = (error: unknown): void =>
    scope.postMessage(
      { kind: "error", message: error instanceof Error ? error.message : String(error) },
      [],
    );
  let surface: ExactSurface | null;
  try {
    surface = createSurface();
  } catch (error) {
    fail(error);
    return;
  }
  scope.postMessage({ kind: "ready", density: surface?.renderer.densityRendering ?? null }, []);
  if (surface === null) return;
  const { canvas, renderer } = surface;
  let columns = new Map<number, Float32Array>();
  let colors: LineColors | null = null;
  let order: Uint32Array | null = null;
  let drawOrder: Uint32Array | null = null;
  scope.onmessage = async ({ data }) => {
    try {
      colors = data.colors ?? colors;
      order = data.order ?? order;
      drawOrder = data.drawOrder ?? drawOrder;
      if (colors === null || order === null || drawOrder === null) {
        throw new Error("Exact worker needs rows, draw order and colors");
      }
      for (const column of data.columns) columns.set(column.id, column.pixels);
      const retained = new Map<number, Float32Array>();
      const axes = data.axes.map((axis) => {
        const pixels = columns.get(axis.column);
        if (pixels === undefined) throw new Error(`Missing exact worker column ${axis.column}`);
        retained.set(axis.column, pixels);
        return { x: axis.x, pixels };
      });
      columns = retained;
      const width = Math.max(1, Math.round(data.width * data.pixelRatio));
      const height = Math.max(1, Math.round(data.height * data.pixelRatio));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      renderer.setRows(order.length, order);
      renderer.setDrawOrder(drawOrder);
      renderer.setColors(colors);
      renderer.setSelection(data.selection);
      await renderer.drawCooperative({ ...data, axes });
      while (renderer.busy) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const finished = renderer.finishedFrame();
      if (finished === null) throw new Error("Exact worker did not finish its frame");
      const bitmap = canvas.transferToImageBitmap();
      scope.postMessage({ kind: "frame", id: data.id, bitmap, finished }, [bitmap]);
    } catch (error) {
      fail(error);
    }
  };
}
