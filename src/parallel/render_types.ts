import type { ContinuousImage } from "./continuous_types";
import type { FinishedFrame, LineColors, LineFocus, LineFrame } from "./webgl";

/** What a frame draws: every row's exact line, or the continuous density of the rows. */
export type RenderMode = "exact" | "continuous";

/**
 * The page's first message: the plot's canvas, whose control it transferred,
 * for the worker to draw on and show.
 */
export interface RenderInit {
  kind: "init";
  canvas: OffscreenCanvas;
}

/**
 * One frame's state. Row data arrives as deltas: columns the worker does not
 * hold, and colors, orders, a selection or focus rows only when they changed.
 * The worker keeps the latest of each, and the columns of the latest axes.
 */
export interface RenderRequest extends Omit<LineFrame, "axes"> {
  kind: "frame";
  id: number;
  mode: RenderMode;
  axes: readonly { column: number; x: number }[];
  columns: readonly { id: number; pixels: Float32Array }[];
  colors?: LineColors;
  /** The shuffled row order, which identifies the rows (exact frames). */
  order?: Uint32Array;
  /** The order exact lines draw in (see WebGLLineRenderer.setDrawOrder). */
  drawOrder?: Uint32Array;
  selection?: Uint8Array;
  /** A brush gesture's axis (exact frames); its rows are sent when they change. */
  focus: (Omit<LineFocus, "rows"> & { rows?: LineFocus["rows"] }) | null;
}

export type RenderMessage = RenderInit | RenderRequest;

/** A continuous image's measurements, without its pixels once the worker showed them. */
export type ContinuousMetrics = Omit<ContinuousImage, "pixels">;

export type RenderReply =
  | {
      kind: "ready";
      /**
       * Whether the worker draws on the canvas: false without WebGL2 in
       * workers, when the page draws exact lines and shows the continuous
       * images the worker returns.
       */
      presents: boolean;
      /** Lines are tone-mapped from float density targets (see WebGLLineRenderer). */
      density: boolean;
      /** Brush frames can sum retained blocks: float targets on a GPU (see LineFocus). */
      blocks: boolean;
    }
  | {
      kind: "frame";
      /** The latest request when the frame started: earlier ones are superseded. */
      id: number;
      mode: RenderMode;
      /** The GPU's frame, when the worker drew it. */
      finished: FinishedFrame | null;
      continuous: ContinuousMetrics | null;
      /** A continuous image for the page to show, when the worker does not present. */
      pixels: Uint8ClampedArray | null;
      /** Selection buffers the worker no longer needs, for the page to reuse. */
      released: Uint8Array[];
    }
  | { kind: "error"; message: string };
