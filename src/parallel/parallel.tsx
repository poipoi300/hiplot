/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// This file is largely inspired from the snippet by Kai Chang
// available in http://bl.ocks.org/syntagmatic/3150059

import * as d3 from "d3";
import $ from "jquery";
import React from "react";
import _ from "underscore";
import { type Filter, FilterType } from "../filters";
import style from "../hiplot.module.css";
import {
  create_d3_scale,
  type ParamDef,
  type ParamScale,
  type ScaleDomainRange,
  scale_pixels_range,
} from "../infertypes";
import { IS_MOBILE } from "../lib/browsercompat";
import type { RGB } from "../lib/colors";
import { labelTextFromHtml } from "../lib/escape";
import { mounted } from "../lib/refs";
import { ResizableH } from "../lib/resizable";
import { isNumber, isStringArray, readState } from "../lib/savedstate";
import type { HiPlotPluginData } from "../plugin";
import { type Datapoint, ParamType } from "../types";
import {
  type AxisValue,
  columnAxis,
  formatTimestamp,
  tickCountFor,
  valueFormatter,
} from "./axisformat";
import { LineGeometry } from "./geometry";
import pstyle from "./parallel.module.css";
import { type AxisSelection, BrushMasks } from "./selection";
import { WebGLLineRenderer } from "./webgl";

interface ParallelPlotState {
  height: number;
  width: number;
  order: Array<string>;
  hide: Set<string>;
  invert: Set<string>;
  dimensions: Array<string>;
  lineShape: LineShape;
  /** Whether any axis is brushed, which enables "Reset brushes". */
  brushed: boolean;
  /** The line under the pointer and where its tooltip goes. */
  hover: { x: number; y: number; text: string } | null;

  dragging: { col: string; pos: number; origin: number; dragging: boolean } | null;
}

interface PPlotInternal {
  redraw_axis: () => void;
  /** Recomputes the selection from the brushes; `publish` hands it to HiPlot. */
  brush: (publish: boolean) => void;
}

// DISPLAYS_DATA_DOC_BEGIN
// Corresponds to values in the dict of `exp.display_data(hip.Displays.PARALLEL_PLOT)`
export interface ParallelPlotDisplayData {
  // Ordering of the columns
  order?: Array<string>;

  // Hidden columns, that won't appear in the parallel plot
  // NOTE: Categorical columns with more than `categoricalMaximumValues` distinct values will be hidden
  // NOTE: Columns with a single value won't appear either unless you provide a min/max
  //       eg: `exp.parameters_definition["column_name"].force_range(0, 100)`
  hide?: Array<string>;

  // These columns will be inverted (higher values are below)
  invert?: Array<string>;

  // Categorical columns with more distinct values that this won't be displayed
  categoricalMaximumValues: number;
}
// DISPLAYS_DATA_DOC_END

export interface ParallelPlotData extends HiPlotPluginData, ParallelPlotDisplayData {
  // Callback to notify parent when hidden columns change
  onHiddenColumnsChange?: (count: number) => void;
}

type BrushExtents = { [dimension: string]: [number, number] | null };
/** An axis title being long-pressed on a touch screen. */
interface LongPress {
  timer: number | null;
  fired: boolean;
}

/** What a brush selects on one axis, as a value range. */
function axisSelection(dimension: string, range: ScaleDomainRange): AxisSelection {
  if (range.type === ParamType.CATEGORICAL) {
    if (range.values.length === 0) {
      return "nothing";
    }
    return {
      col: dimension,
      type: range.type,
      min: range.values[0],
      max: range.values[range.values.length - 1],
    };
  }
  return {
    col: dimension,
    type: range.type,
    min: Math.min(...range.range),
    max: Math.max(...range.range),
    include_infnans: range.include_infnans,
  };
}

interface AxisPixels {
  x: number;
  pixels: Float32Array;
}

/**
 * Adds one row's polyline to the current path, from cached pixels: Bezier
 * segments between axes, a short horizontal stub at each end, and a break
 * around missing values (NaN pixels).
 */
function traceRow(
  ctx: CanvasRenderingContext2D,
  axes: ReadonlyArray<AxisPixels>,
  row: number,
  curved: boolean,
): void {
  let has_started = false;
  let x0 = 0;
  let y0 = 0;
  for (const axis of axes) {
    const x = axis.x;
    const y = axis.pixels[row];
    if (Number.isNaN(y)) {
      if (has_started) {
        ctx.lineTo(x0 + 15, y0); // right edge
      }
      has_started = false;
      continue;
    }
    if (!has_started) {
      x0 = x - 15;
      y0 = y;
      ctx.moveTo(x0, y0);
      has_started = true;
    }
    if (curved) {
      ctx.bezierCurveTo(x - 0.88 * (x - x0), y0, x - 0.12 * (x - x0), y, x, y);
    } else {
      ctx.lineTo(x, y);
    }
    x0 = x;
    y0 = y;
  }
  if (has_started) {
    ctx.lineTo(x0 + 15, y0); // right edge
  }
}

/** Axis titles: angle, start offset from the axis top, and longest drawn length. */
const TITLE_ANGLE_DEGREES = 35;
const TITLE_START_X = 4;
const TITLE_START_Y = -18;
const TITLE_MAX_PIXELS = 150;
/** The drag grip sits between the axis top and its title. */
const GRIP_OFFSET_Y = -9;
/** Brush range labels sit right of the brush band. */
const BRUSH_LABEL_X = 18;

/** Widths of a highlighted line and of the halo around it. */
const HIGHLIGHT_WIDTH = 2.5;
const HALO_WIDTH = 7;
/** How far the pointer may be from a line to pick it. */
const HOVER_DISTANCE_PIXELS = 5;

/**
 * How far between its two axes a line is at fraction `s` of the gap: the line
 * is at yLeft + (yRight - yLeft) * weight. For the Bezier curves (control points
 * at 12% and 88% of the gap, level with each end) x(t) is solved by bisection.
 */
export function segmentWeight(s: number, curved: boolean): number {
  const clamped = Math.max(0, Math.min(1, s));
  if (!curved) {
    return clamped;
  }
  const xAt = (t: number): number => {
    const u = 1 - t;
    return 3 * u * u * t * 0.12 + 3 * u * t * t * 0.88 + t * t * t;
  };
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; ++i) {
    const mid = (low + high) / 2;
    if (xAt(mid) < clamped) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const t = (low + high) / 2;
  return 3 * (1 - t) * t * t + t * t * t;
}

/** Bin key of the deselected rows in the Canvas 2D fallback. */
const CONTEXT_BIN = -1;
/** "auto" switches to straight segments above this many rows, where curves blur into mush. */
const STRAIGHT_LINES_ABOVE_ROWS = 10_000;
/** Peak opacity of the deselected-rows layer per theme. */
const CONTEXT_ALPHA_LIGHT = 0.28;
const CONTEXT_ALPHA_DARK = 0.34;

export type LineShape = "auto" | "curved" | "straight";
const isLineShape = (value: unknown): value is LineShape =>
  value === "auto" || value === "curved" || value === "straight";

/** Target frame interval while lines draw progressively (60 Hz). */
const FRAME_BUDGET_MS = 16;
const INITIAL_MS_PER_LINE = 0.05;
const MIN_LINES_PER_FRAME = 100;
const MAX_LINES_PER_FRAME = 50_000;

const TOP_MARGIN_PIXELS = 120;
const H_MARGIN_PIXELS = 20;
export class ParallelPlot extends React.Component<ParallelPlotData, ParallelPlotState> {
  on_resize: (() => void) | null = null;
  m = [
    TOP_MARGIN_PIXELS, // top
    H_MARGIN_PIXELS * 0.25, // right
    TOP_MARGIN_PIXELS * 0.125, // bottom
    H_MARGIN_PIXELS * 1.75, // left
  ]; // Margins
  // Available space minus margins
  w = 0;
  h = 0;

  pplot: PPlotInternal | null = null;

  dimensions_dom: d3.Selection<SVGGElement, string, SVGGElement, unknown> | null = null;
  /** Cached per-row pixels, colors and draw order of the filtered rows. */
  private lineGeometry: LineGeometry | null = null;
  /** Per-axis brush masks over the filtered rows. */
  private masks: BrushMasks | null = null;
  /** Line renderer on the GPU; null when WebGL2 is unavailable and Canvas 2D draws. */
  webgl: WebGLLineRenderer | null = null;
  /** The selection flags last computed, reused while the selection is unchanged. */
  private maskMemo: {
    geometry: LineGeometry;
    rows: ReadonlyArray<Datapoint>;
    mask: Uint8Array;
  } | null = null;
  /** The rows whose lines are drawn: the brush selection, or a selection made elsewhere. */
  private drawnSelection: ReadonlyArray<Datapoint> | null = null;
  /** The last selection this plot handed to HiPlot. */
  private publishedSelection: ReadonlyArray<Datapoint> | null = null;
  /** Incremented by every draw, so a progressive draw stops once superseded. */
  private drawGeneration = 0;
  /** The pending animation frame of a progressive draw, if one is in flight. */
  drawingFrame: number | null = null;
  /** Smoothed cost of one line, from measured frame intervals (see `paths`). */
  msPerLine = INITIAL_MS_PER_LINE;

  xscale: d3.ScalePoint<string> = d3.scalePoint<string>();

  // Rendering
  root_ref = React.createRef<HTMLDivElement>();
  foreground_ref = React.createRef<HTMLCanvasElement>();
  foreground: CanvasRenderingContext2D | null = null;
  highlighted_ref = React.createRef<HTMLCanvasElement>();
  highlighted: CanvasRenderingContext2D | null = null;

  svg_ref = React.createRef<SVGSVGElement>();
  svgg_ref = React.createRef<SVGGElement>();

  // Dimensions, scaling and axis
  yscale: { [dimension: string]: ParamScale } = {};
  d3brush = d3.brushY<string>();

  private longPresses = new WeakMap<SVGTextElement, LongPress>();

  private getBrushExtents(): BrushExtents {
    const extents: BrushExtents = {};
    if (!this.dimensions_dom) {
      return extents;
    }
    this.dimensions_dom.selectAll<SVGGElement, string>(`.${pstyle.brush}`).each(function (
      this: SVGGElement,
      dim: string,
    ) {
      const selection = d3.brushSelection(this);
      extents[dim] = selection === null ? null : (selection as [number, number]);
    });
    return extents;
  }

  private highlightContext(): CanvasRenderingContext2D {
    if (this.highlighted === null) {
      throw new Error("The parallel plot is not initialized yet");
    }
    return this.highlighted;
  }

  /** Horizontal position of a displayed dimension's axis. */
  xPosition(dimension: string): number {
    const x = this.xscale(dimension);
    if (x === undefined) {
      throw new Error(`Dimension ${dimension} is not displayed`);
    }
    return x;
  }

  toggleInvertAxis(d: string): [number, number] | null {
    // save extent before inverting
    const currentExtent = this.getBrushExtents()[d];
    const extent: [number, number] | null = currentExtent
      ? [this.h - currentExtent[1], this.h - currentExtent[0]]
      : null;
    const labels = d3
      .select(mounted(this.root_ref))
      .selectAll<SVGTextElement, string>(`.${pstyle.pplotLabel}`)
      .filter((p) => p === d);

    const willBeInverted = !this.state.invert.has(d);
    this.setState((prevState) => {
      const newInvert = new Set(prevState.invert);
      if (willBeInverted) {
        newInvert.add(d);
      } else {
        newInvert.delete(d);
      }
      return { invert: newInvert };
    });
    this.setScaleRange(d, willBeInverted);
    if (willBeInverted) {
      labels.style("text-decoration", "underline");
    } else {
      labels.style("text-decoration", null);
    }
    return extent;
  }

  constructor(props: ParallelPlotData) {
    super(props);
    this.state = {
      height: readState(
        props.persistentState,
        "height",
        isNumber,
        props.window_state.height ?? 600,
      ),
      width: 0, // Will be initialized to element width
      order: readState(props.persistentState, "order", isStringArray, props.order ?? []),
      hide: new Set(readState(props.persistentState, "hide", isStringArray, props.hide ?? [])),
      invert: new Set(
        readState(props.persistentState, "invert", isStringArray, props.invert ?? []),
      ),
      dimensions: [],
      lineShape: readState(props.persistentState, "lineShape", isLineShape, "auto"),
      brushed: false,
      hover: null,
      dragging: null,
    };
  }
  static defaultProps = {
    categoricalMaximumValues: 200,
  };
  componentWillUnmount() {
    d3.select(this.svgg_ref.current).selectAll("*").remove();
    this.cancelDrawing();
    this.webgl?.dispose();
    this.webgl = null;
    this.props.context_menu_ref?.current?.removeCallbacks(this);
    this.cancelBrushMove();
    this.sendBrushExtents.cancel();
  }
  componentDidUpdate(prevProps: ParallelPlotData, prevState: ParallelPlotState) {
    if (prevState.height !== this.state.height || prevState.width !== this.state.width) {
      this.on_resize?.();
    }
    if (prevState.invert !== this.state.invert) {
      this.props.persistentState.set("invert", Array.from(this.state.invert));
    }
    if (prevState.hide !== this.state.hide) {
      this.props.persistentState.set("hide", Array.from(this.state.hide));
      this.props.onHiddenColumnsChange?.(this.getRestorableColumnsCount());
    }
    if (prevState.lineShape !== this.state.lineShape) {
      this.props.persistentState.set("lineShape", this.state.lineShape);
    }
    if (prevState.order !== this.state.order) {
      this.props.persistentState.set("order", this.state.order);
    }
    if (prevState.dimensions !== this.state.dimensions && this.dimensions_dom !== null) {
      const g = d3.select(this.svgg_ref.current).selectAll<SVGGElement, string>(".dimension");
      this.xscale.domain(this.state.dimensions);
      this.dimensions_dom.filter((p) => this.state.dimensions.indexOf(p) === -1).remove();
      this.dimensions_dom = this.dimensions_dom.filter(
        (p) => this.state.dimensions.indexOf(p) !== -1,
      );
      const translate = (p: string) => `translate(${this.position(p)})`;
      if (this.state.dragging) {
        g.attr("transform", translate);
      } else {
        g.transition().attr("transform", translate);
      }

      this.update_ticks();
      this.updateAxisTitlesAnglesAndFontSize();
      // Dimensions affect which columns can be restored
      this.props.onHiddenColumnsChange?.(this.getRestorableColumnsCount());
    }
    // Highlight polylines
    if (prevProps.rows_highlighted !== this.props.rows_highlighted && this.highlighted !== null) {
      const highlighted = this.highlighted;
      highlighted.clearRect(0, 0, this.w, this.h);
      if (this.props.rows_highlighted.length === 0) {
        d3.select(this.foreground_ref.current).style("opacity", null);
      } else {
        d3.select(this.foreground_ref.current).style("opacity", "0.45");
        const halo = getComputedStyle(mounted(this.root_ref)).getPropertyValue("--hip-halo");
        highlighted.lineJoin = "round";
        highlighted.lineCap = "round";
        this.props.rows_highlighted.forEach((dp: Datapoint) => {
          // A halo in the background color lifts the line off the density beneath it.
          highlighted.lineWidth = HALO_WIDTH;
          this.path(dp, highlighted, halo);
          highlighted.lineWidth = HIGHLIGHT_WIDTH;
          this.path(dp, highlighted, this.props.get_color_for_row(dp, 1));
        });
      }
    }
    // Recompute scales - when dimensions got removed, or scaling changed for one
    if (
      this.pplot &&
      (this.state.dimensions !== prevState.dimensions ||
        prevProps.params_def !== this.props.params_def)
    ) {
      const drop_scales: string[] = [];
      this.state.dimensions.forEach((d: string) => {
        const new_scale = this.createScale(d);
        if (new_scale === null) {
          drop_scales.push(d);
          return;
        }
        this.yscale[d] = new_scale;
      });
      drop_scales.forEach((d: string) => {
        this.remove_axis(d);
      });
    }
    // Dimension added - redraw missing axis
    const oldDimsSet = new Set(prevState.dimensions);
    if (this.pplot && !this.state.dimensions.every((value) => oldDimsSet.has(value))) {
      this.pplot.redraw_axis();
    }
    // Rescale to new dataset domain
    if (this.pplot && prevProps.params_def !== this.props.params_def) {
      this.brush_clear_all();
      this.update_ticks();
      this.cancelDrawing();
    }
    // A selection made elsewhere (table search, Keep/Exclude): draw it. Our own
    // brush selections are already drawn when they are published.
    const selectionChanged =
      prevProps.rows_selected !== this.props.rows_selected &&
      this.props.rows_selected !== this.publishedSelection;
    if (selectionChanged) {
      this.drawnSelection = this.props.rows_selected;
    }
    if (
      selectionChanged ||
      prevProps.color_binning !== this.props.color_binning ||
      prevProps.dark !== this.props.dark ||
      prevState.lineShape !== this.state.lineShape ||
      prevProps.colorby !== this.props.colorby ||
      prevState.height !== this.state.height ||
      prevState.width !== this.state.width
    ) {
      this.redrawLines();
    }
    this.props.window_state.height = this.state.height;
  }
  /** Brush moves are coalesced to one selection update per animation frame. */
  private brushMoveFrame: number | null = null;
  onBrushMove = (): void => {
    if (this.brushMoveFrame !== null) {
      return;
    }
    this.brushMoveFrame = requestAnimationFrame(() => {
      this.brushMoveFrame = null;
      this.pplot?.brush(false);
    });
  };
  onBrushEnd = (): void => {
    this.cancelBrushMove();
    this.sendBrushExtents();
    this.pplot?.brush(true);
  };
  cancelBrushMove(): void {
    if (this.brushMoveFrame !== null) {
      cancelAnimationFrame(this.brushMoveFrame);
      this.brushMoveFrame = null;
    }
  }
  onResize = (height: number, width: number): void => {
    if (this.state.height !== height || this.state.width !== width) {
      this.setState({ height: height, width: width });
    }
  };

  get_axis(d: string): d3.Axis<AxisValue> {
    return columnAxis(this.yscale[d], this.h);
  }

  render() {
    const shapes: { shape: LineShape; label: string; title: string }[] = [
      {
        shape: "auto",
        label: "Auto",
        title: `Curves up to ${STRAIGHT_LINES_ABOVE_ROWS.toLocaleString("en-US")} rows, straight beyond`,
      },
      { shape: "curved", label: "Curved", title: "Smooth curves between axes" },
      { shape: "straight", label: "Straight", title: "Straight segments between axes" },
    ];
    return (
      <>
        <div className={pstyle.toolbar}>
          <span>Lines</span>
          <fieldset className={pstyle.segmented} aria-label="Line shape">
            {shapes.map(({ shape, label, title }) => (
              <button
                key={shape}
                type="button"
                title={title}
                aria-pressed={this.state.lineShape === shape}
                onClick={() => this.setState({ lineShape: shape })}
              >
                {label}
              </button>
            ))}
          </fieldset>
          <button
            type="button"
            className={pstyle.toolbarButton}
            disabled={!this.state.brushed}
            title="Clear every brush and select all rows"
            onClick={() => this.brush_clear_all()}
          >
            Reset brushes
          </button>
        </div>
        <ResizableH initialHeight={this.state.height} onResize={this.onResize}>
          <div
            ref={this.root_ref}
            className={`${pstyle["parallel-plot-chart"]} pplot-root`}
            style={{ height: this.state.height }}
          >
            <canvas ref={this.foreground_ref}></canvas>
            <canvas ref={this.highlighted_ref}></canvas>
            <svg
              ref={this.svg_ref}
              width={this.state.width}
              height={this.state.height}
              role="img"
              aria-label="Parallel coordinates axes"
              onMouseMove={this.onPointerMove}
              onMouseLeave={this.clearHover}
            >
              <g ref={this.svgg_ref} transform={`translate(${this.m[3]}, ${this.m[0]})`}></g>
            </svg>
            {this.state.hover !== null && (
              <div
                className={pstyle.tooltip}
                style={{ left: this.state.hover.x, top: this.state.hover.y }}
                data-testid="line-tooltip"
              >
                {this.state.hover.text}
              </div>
            )}
          </div>
        </ResizableH>
      </>
    );
  }

  /** The row under the pointer is found every frame at most, from the cached pixels. */
  private hoverFrame: number | null = null;
  onPointerMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    if (event.buttons !== 0) {
      return;
    }
    const [x, y] = d3.pointer(event.nativeEvent, mounted(this.svgg_ref));
    if (this.hoverFrame !== null) {
      cancelAnimationFrame(this.hoverFrame);
    }
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = null;
      this.hoverAt(x, y);
    });
  };
  clearHover = (): void => {
    if (this.hoverFrame !== null) {
      cancelAnimationFrame(this.hoverFrame);
      this.hoverFrame = null;
    }
    if (this.hoveredRow !== null) {
      this.hoveredRow = null;
      this.setState({ hover: null });
      this.props.setHighlighted([]);
    }
  };
  private hoveredRow: Datapoint | null = null;

  /** Highlights the selected line nearest to plot coordinates (x, y), if one is close. */
  hoverAt(x: number, y: number): void {
    const geometry = this.geometry();
    const axes = this.state.dimensions
      .map((dimension) => ({ dimension, x: this.position(dimension) }))
      .sort((a, b) => a.x - b.x);
    const right = axes.findIndex((axis) => axis.x > x);
    if (right <= 0) {
      this.clearHover();
      return;
    }
    const left = axes[right - 1];
    const leftPixels = geometry.pixels(
      left.dimension,
      this.yscale[left.dimension],
      this.props.params_def[left.dimension].numeric,
    );
    const rightPixels = geometry.pixels(
      axes[right].dimension,
      this.yscale[axes[right].dimension],
      this.props.params_def[axes[right].dimension].numeric,
    );
    const weight = segmentWeight((x - left.x) / (axes[right].x - left.x), this.curvedLines());
    const mask = this.selectionMask(geometry);
    let nearest = -1;
    let nearestDistance = HOVER_DISTANCE_PIXELS;
    for (let row = 0; row < mask.length; ++row) {
      if (mask[row] === 0) {
        continue;
      }
      const yLeft = leftPixels[row];
      const yRight = rightPixels[row];
      const distance = Math.abs(yLeft + (yRight - yLeft) * weight - y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = row;
      }
    }
    if (nearest === -1) {
      this.clearHover();
      return;
    }
    const row = geometry.rows[nearest];
    const value = row[this.props.colorby];
    const text = `${this.props.render_row_text(row)} · ${this.props.colorby} ${value === undefined ? "missing" : String(value)}`;
    this.setState({ hover: { x: x + this.m[3], y: y + this.m[0], text } });
    if (row !== this.hoveredRow) {
      this.hoveredRow = row;
      this.props.setHighlighted([row]);
    }
  }
  sendBrushExtents = _.debounce((): void => {
    this.props.sendMessage("brush_extents", () => {
      const colToScale: { [dimension: string]: ScaleDomainRange } = {};
      Object.entries(this.getBrushExtents()).forEach(([dim, extent]) => {
        if (extent !== null) {
          colToScale[dim] = scale_pixels_range(this.yscale[dim], extent);
        }
      });
      return colToScale;
    });
  }, 400);
  forceHideColumn(pd: ParamDef | undefined): boolean {
    return (
      pd === undefined ||
      pd.distinct_values.length <= 1 ||
      (pd.type === ParamType.CATEGORICAL &&
        pd.distinct_values.length > this.props.categoricalMaximumValues)
    );
  }
  componentDidMount() {
    const order = this.state.order;
    const orderIndex = (dimension: string): number => {
      const index = order.indexOf(dimension);
      return index === -1 ? order.length : index;
    };
    const dimensions = Object.keys(this.props.params_def)
      .filter((k: string) => {
        if (this.forceHideColumn(this.props.params_def_unfiltered[k]) || this.state.hide.has(k)) {
          return false;
        }
        const scale = this.createScale(k);
        if (scale !== null) {
          this.yscale[k] = scale;
        }
        return true;
      })
      .reverse()
      .sort((a, b) => orderIndex(a) - orderIndex(b));
    this.setState(
      {
        width: this.state.width === 0 ? mounted(this.root_ref).offsetWidth : this.state.width,
        dimensions: dimensions,
        order: Array.from(dimensions),
      },
      this.initParallelPlot.bind(this),
    );

    this.props.context_menu_ref?.current?.addCallback(this.columnContextMenu.bind(this), this);
    // Notify parent of initial hidden columns count
    const count = this.getRestorableColumnsCount();
    if (count > 0) {
      this.props.onHiddenColumnsChange?.(count);
    }
  }
  columnContextMenu(column: string, cm: HTMLDivElement) {
    if (!this.can_restore_axis(column)) {
      return;
    }
    const restore_btn = $(`<a class="dropdown-item" href="#">Restore in Parallel Plot</a>`);
    restore_btn.on("click", (event) => {
      this.restore_axis(column);
      event.preventDefault();
    });
    $(cm).append(restore_btn);
  }

  position(d: string): number {
    if (this.state.dragging && d === this.state.dragging.col) {
      return this.state.dragging.pos;
    }
    return this.xPosition(d);
  }

  private showContextMenu(pageX: number, pageY: number, dimension: string): boolean {
    const menu = this.props.context_menu_ref?.current;
    if (!menu) {
      return false;
    }
    menu.show(pageX, pageY, dimension);
    return true;
  }

  initParallelPlot() {
    const me = this;

    const div = d3.select(mounted(me.root_ref));
    const svg = d3.select(mounted(me.svg_ref));

    // Foreground canvas for the lines: WebGL2 when available, Canvas 2D otherwise
    const foregroundCanvas = mounted(this.foreground_ref);
    me.webgl = WebGLLineRenderer.create(foregroundCanvas);
    if (me.webgl === null) {
      const foreground = foregroundCanvas.getContext("2d");
      if (foreground === null) {
        throw new Error("Neither WebGL2 nor Canvas 2D is available");
      }
      foreground.globalCompositeOperation = "destination-over";
      me.foreground = foreground;
    }
    // Highlight canvas for temporary interactions
    const highlighted = mounted(this.highlighted_ref).getContext("2d");
    if (highlighted === null) {
      throw new Error("Canvas 2D is not available");
    }
    me.highlighted = highlighted;

    // Load the data and visualization
    function redraw_axis(): void {
      // Extract the list of numerical dimensions and create a scale for each.
      me.xscale.domain(me.state.dimensions);

      // Add a group element for each dimension.
      function create_drag_beh(): d3.DragBehavior<SVGElement, string, unknown> {
        return d3
          .drag<SVGElement, string>()
          .container(() => mounted(me.svgg_ref))
          .on("start", (_event, d: string) => {
            me.setState({
              dragging: {
                col: d,
                pos: me.xPosition(d),
                origin: me.xPosition(d),
                dragging: false,
              },
            });
            d3.select(me.foreground_ref.current).style("opacity", "0.35");
          })
          .on("drag", function (this: SVGElement, event: { dx: number }, d: string) {
            const eventdx = event.dx;
            const brushEl = d3.select(this).select(`.${pstyle.brush}`);
            me.setState(
              (prevState) => {
                if (!prevState.dragging) {
                  return null;
                }
                return {
                  dragging: {
                    col: d,
                    pos: Math.min(me.w, Math.max(0, prevState.dragging.pos + eventdx)),
                    origin: prevState.dragging.origin,
                    dragging: true,
                  },
                };
              },
              () => {
                // Feedback for axis deletion if dropped
                if (!me.state.dragging) {
                  return;
                }
                if (me.state.dragging.pos < 12 || me.state.dragging.pos > me.w - 12) {
                  brushEl.style("fill", "red");
                } else {
                  brushEl.style("fill", null);
                }
              },
            );

            const new_dimensions = Array.from(me.state.dimensions);
            new_dimensions.sort((a, b) => me.position(a) - me.position(b));
            if (!new_dimensions.every((val, idx) => val === me.state.dimensions[idx])) {
              me.setState({ dimensions: new_dimensions });
            }
            me.dimensions_dom?.attr("transform", (dim) => `translate(${me.position(dim)})`);
          })
          .on("end", function (this: SVGElement, _event, d: string) {
            if (!me.state.dragging) {
              d3.select(me.foreground_ref.current).style("opacity", null);
              return;
            }
            if (!me.state.dragging.dragging) {
              // no movement, invert axis
              if (!IS_MOBILE) {
                const extent = me.toggleInvertAxis(d);
                me.update_ticks(d, extent);
              }
            } else if (me.state.dragging.pos < 12 || me.state.dragging.pos > me.w - 12) {
              // remove axis if dragged all the way left
              me.remove_axis(d);
            } else {
              const dimensionGroup = this.closest(".dimension");
              me.setState({ order: Array.from(me.state.dimensions), dragging: null }, () => {
                // reorder axes
                d3.select(dimensionGroup)
                  .transition()
                  .attr("transform", `translate(${me.xPosition(d)})`);
                me.update_ticks(d, me.getBrushExtents()[d]);
              });
            }

            // rerender
            d3.select(me.foreground_ref.current).style("opacity", null);
            me.setState({ dragging: null });
          });
      }
      me.dimensions_dom?.remove();
      const dimensions_dom = d3
        .select(mounted(me.svgg_ref))
        .selectAll<SVGGElement, string>(".dimension")
        // reverse the order so that the tooltips appear on top of the axis ticks
        .data(me.state.dimensions.slice().reverse())
        .enter()
        .append<SVGGElement>("svg:g")
        .attr("class", "dimension")
        .attr("transform", (d) => `translate(${me.xPosition(d)})`);
      me.dimensions_dom = dimensions_dom;

      // Add an axis and title.
      dimensions_dom
        .append<SVGGElement>("svg:g")
        .attr("class", pstyle.axis)
        .attr("transform", "translate(0,0)")
        .each(function (this: SVGGElement, d) {
          d3.select(this).call(me.get_axis(d));
        })
        .append("text")
        .text((dim) => {
          const pd = me.props.params_def[dim];
          return labelTextFromHtml(pd.label_html, pd.name);
        })
        .attr("data-dimension", (dim) => dim)
        .classed("pplot-label", true)
        .classed("label-name", true)
        .classed(style.axisLabelText, true)
        .classed(pstyle.pplotLabel, true)
        .each(function (this: SVGTextElement, dim) {
          const pd = me.props.params_def[dim];
          const hint = IS_MOBILE
            ? "long-press for options"
            : "click to invert, drag to move, right-click for options";
          d3.select(this)
            .append("title")
            .text(`${labelTextFromHtml(pd.label_html, pd.name)} (${hint})`);
        })
        .on("contextmenu", (event: MouseEvent, dim: string) => {
          if (me.showContextMenu(event.pageX, event.pageY, dim)) {
            event.preventDefault();
            event.stopPropagation();
          }
        })
        .on("touchstart", function (this: SVGTextElement, event: TouchEvent, dim: string) {
          if (!me.props.context_menu_ref?.current) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const touch = event.touches[0];
          const press: LongPress = { timer: null, fired: false };
          press.timer = window.setTimeout(() => {
            me.showContextMenu(touch.pageX, touch.pageY, dim);
            press.fired = true;
            press.timer = null;
          }, 500);
          me.longPresses.set(this, press);
        })
        .on(
          "touchend touchcancel touchmove",
          function (this: SVGTextElement, event: TouchEvent, dim: string) {
            const press = me.longPresses.get(this);
            if (press?.timer) {
              window.clearTimeout(press.timer);
              press.timer = null;
            }
            if (press?.fired) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (event.type !== "touchend") {
              return;
            }
            if (me.state.dragging?.dragging) {
              return;
            }
            const touch = event.changedTouches[0];
            if (me.showContextMenu(touch.pageX, touch.pageY, dim)) {
              event.preventDefault();
              event.stopPropagation();
            }
          },
        );
      me.updateAxisTitlesAnglesAndFontSize();
      dimensions_dom.selectAll<SVGElement, string>(".pplot-label").call(create_drag_beh());

      // A grip above each axis: a second, more visible handle to drag it by.
      const grips = dimensions_dom
        .append<SVGElement>("svg:g")
        .classed(pstyle.grip, true)
        .attr("transform", `translate(0, ${GRIP_OFFSET_Y})`);
      grips
        .append("title")
        .text("Drag to move this axis, or out of the plot to hide it; click to invert it");
      grips.append("rect").attr("x", -7).attr("y", -6).attr("width", 14).attr("height", 12);
      for (const cx of [-2.5, 2.5]) {
        for (const cy of [-3.5, 0, 3.5]) {
          grips.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 1.1);
        }
      }
      grips.call(create_drag_beh());

      // Add and store a brush for each axis.
      dimensions_dom
        .append<SVGGElement>("svg:g")
        .classed(pstyle.brush, true)
        .classed("pplot-brush", true)
        .each(function (this: SVGGElement) {
          d3.select<SVGGElement, string>(this).call(me.d3brush);
        })
        .selectAll("rect")
        .style("visibility", null)
        .append("title")
        .text("Drag up or down to brush along this axis");

      dimensions_dom.selectAll(".extent").append("title").text("Drag or resize this filter");
    }

    function brush(publish: boolean): void {
      /**
       * Called whenever a brush moves. Recomputes and draws the selected lines
       * right away; with `publish`, also hands the selection to HiPlot, which
       * updates the other displays (done when a brush gesture ends).
       */
      me.props.context_menu_ref?.current?.hide();
      const extents = me.getBrushExtents();
      const actives = me.state.dimensions.filter(
        (p) => extents[p] !== null && extents[p] !== undefined,
      );

      // hack to hide ticks beyond extent
      me.dimensions_dom?.each(function (this: SVGGElement, dimension) {
        const extent = extents[dimension];
        const texts = d3.select(this).selectAll<SVGTextElement, AxisValue>(".tick text");
        if (extent !== null && extent !== undefined && _.include(actives, dimension)) {
          const scale = me.yscale[dimension];
          texts
            .classed(pstyle.tickSelected, true)
            .style("display", function (this: SVGTextElement) {
              if (d3.select(this).classed(pstyle.pplotLabel)) {
                return null;
              }
              const position = scale(d3.select<SVGTextElement, AxisValue>(this).datum());
              return extent[0] <= position && position <= extent[1] ? null : "none";
            });
        } else {
          texts.classed(pstyle.tickSelected, false).style("display", null);
        }
        d3.select(this).selectAll(`.${pstyle.pplotLabel}`).style("display", null);
      });

      me.updateBrushRangeLabels(extents);
      if (me.state.brushed !== actives.length > 0) {
        me.setState({ brushed: actives.length > 0 });
      }

      // bold dimensions with label
      div
        .selectAll<SVGTextElement, string>(`.${pstyle.pplotLabel}`)
        .style("font-weight", (dimension) => (_.include(actives, dimension) ? "bold" : null));

      // Get lines within extents
      const selections = new Map<string, AxisSelection>();
      actives.forEach((dimension) => {
        const extent = extents[dimension];
        if (extent === null || extent === undefined) {
          throw new Error(`Dimension ${dimension} is not brushed`);
        }
        selections.set(
          dimension,
          axisSelection(dimension, scale_pixels_range(me.yscale[dimension], extent)),
        );
      });
      const filters = Array.from(
        selections.values(),
        (selection): Filter =>
          selection === "nothing"
            ? { type: FilterType.None, data: {} }
            : { type: FilterType.Range, data: selection },
      );
      const masks = me.brushMasks();
      const mask = masks.select(selections);
      const selected = masks.selectedRows(mask);
      me.drawnSelection = selected;
      if (masks.rows === me.geometry().rows) {
        me.maskMemo = { geometry: me.geometry(), rows: selected, mask };
      }
      me.redrawLines();
      if (!publish) {
        return;
      }

      if (me.props.asserts) {
        me.assertPixelSelectionMatches(actives, extents, filters, selected);
      }
      me.publishedSelection = selected;
      me.props.setSelected(selected, {
        type: FilterType.All,
        data: filters,
      });
    }

    // scale to window size
    this.on_resize = _.debounce(() => {
      me.compute_dimensions();

      div
        .selectAll<SVGGElement, string>(".dimension")
        .attr("transform", (d) => `translate(${me.xPosition(d)})`);
      // update brush placement
      svg.selectAll<SVGGElement, string>(`.${pstyle.brush}`).call(me.d3brush);

      // update axis placement
      div.selectAll<SVGGElement, string>(`.${pstyle.axis}`).each(function (this: SVGGElement, d) {
        d3.select(this).call(me.get_axis(d));
      });
      me.updateAxisTitlesAnglesAndFontSize();

      me.redrawLines();
      this.props.sendMessage("height_changed", () => null);
    }, 100);

    me.compute_dimensions();
    redraw_axis();

    me.pplot = {
      redraw_axis: redraw_axis,
      brush: brush,
    };

    // Initial selection and full foreground
    brush(true);
    me.sendBrushExtents();
  }

  /**
   * Debug check, off unless the `asserts` prop is set: rows selected by value
   * must match the rows whose cached pixels fall inside the brushes, within one
   * pixel.
   */
  private assertPixelSelectionMatches(
    actives: string[],
    extents: BrushExtents,
    filters: Filter[],
    selected: Datapoint[],
  ): void {
    const geometry = this.geometry();
    const columns = actives.map((dimension) => ({
      extent: extents[dimension],
      pixels: geometry.pixels(
        dimension,
        this.yscale[dimension],
        this.props.params_def[dimension].numeric,
      ),
    }));
    const insideBrushes = (index: number, tolerance: number): boolean =>
      columns.every(({ extent, pixels }) => {
        if (extent === null || extent === undefined) {
          return false;
        }
        const position = pixels[index];
        return extent[0] + tolerance <= position && position <= extent[1] - tolerance;
      });
    const rows = geometry.rows;
    const selected_pixels_minset = rows.filter((_row, index) => insideBrushes(index, 1));
    const selected_pixels_maxset = rows.filter((_row, index) => insideBrushes(index, -1));
    const missed = _.difference(selected_pixels_minset, selected);
    const overselected = _.difference(selected, selected_pixels_maxset);
    if (overselected.length || missed.length) {
      console.error(
        `Warning! Filter on ${actives.join(" ")} (`,
        filters,
        ") does not match actually selected rows",
        " Computed rows with filter:",
        selected,
        " Missed:",
        missed,
        " Falsely selected:",
        overselected,
      );
    }
  }

  setScaleRange(k: string, inverted: boolean = this.state.invert.has(k)) {
    this.yscale[k].range(inverted ? [0, this.h] : [this.h, 0]);
  }

  createScale(k: string): ParamScale | null {
    const pd = this.props.params_def[k];
    if (pd === undefined) {
      return null;
    }
    const scale = create_d3_scale(pd);
    scale.range(this.state.invert.has(k) ? [0, this.h] : [this.h, 0]);
    return scale;
  }

  /**
   * Axis titles run up and to the right at a fixed angle from the top of each
   * axis, truncated with an ellipsis to what fits above the plot and inside its
   * right edge; the full name is in the tooltip.
   */
  updateAxisTitlesAnglesAndFontSize() {
    const svgWidth = this.state.width;
    const leftMargin = this.m[3];
    const angle = (TITLE_ANGLE_DEGREES * Math.PI) / 180;
    const me = this;
    this.dimensions_dom?.selectAll<SVGTextElement, string>(".pplot-label").each(function (
      this: SVGTextElement,
      dim,
    ) {
      const pd = me.props.params_def[dim];
      const fullText = labelTextFromHtml(pd.label_html, pd.name);
      const axisX = leftMargin + me.position(dim);
      const roomRight = (svgWidth - axisX - TITLE_START_X - 4) / Math.cos(angle);
      const maxLength = Math.max(24, Math.min(TITLE_MAX_PIXELS, roomRight));
      this.setAttribute("x", "0");
      this.setAttribute("y", "0");
      this.setAttribute("text-anchor", "start");
      this.setAttribute(
        "transform",
        `translate(${TITLE_START_X}, ${TITLE_START_Y}) rotate(${-TITLE_ANGLE_DEGREES})`,
      );
      const textNode = this.firstChild;
      if (textNode === null || textNode.nodeType !== Node.TEXT_NODE) {
        throw new Error("Axis title lost its text node");
      }
      textNode.textContent = fullText;
      if (this.getComputedTextLength() <= maxLength) {
        return;
      }
      let low = 0;
      let high = fullText.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        textNode.textContent = `${fullText.slice(0, mid)}…`;
        if (this.getComputedTextLength() <= maxLength) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      textNode.textContent = `${fullText.slice(0, low)}…`;
    });
  }

  /** Value labels at both ends of each brush. */
  private updateBrushRangeLabels(extents: BrushExtents): void {
    this.dimensions_dom?.each((dimension, index, nodes) => {
      const extent = extents[dimension];
      const scale = this.yscale[dimension];
      const labels: { y: number; text: string; baseline: string }[] = [];
      if (extent !== null && extent !== undefined && scale !== undefined) {
        const [top, bottom] = extent;
        const valueAt = (pixel: number): string => {
          if (scale.kind === "continuous") {
            if (scale.paramType === ParamType.TIMESTAMP) {
              return formatTimestamp(scale.invert(pixel));
            }
            const format = valueFormatter(scale, tickCountFor(this.h));
            return format(scale.invert(pixel));
          }
          const range = scale_pixels_range(scale, [pixel, pixel]);
          return range.type === ParamType.CATEGORICAL && range.values.length > 0
            ? range.values[0]
            : "";
        };
        const range = scale_pixels_range(scale, extent);
        if (range.type === ParamType.CATEGORICAL) {
          labels.push(
            { y: top - 4, text: range.values[0] ?? "", baseline: "auto" },
            {
              y: bottom + 4,
              text: range.values[range.values.length - 1] ?? "",
              baseline: "hanging",
            },
          );
        } else {
          labels.push(
            { y: top - 4, text: valueAt(top), baseline: "auto" },
            { y: bottom + 4, text: valueAt(bottom), baseline: "hanging" },
          );
        }
      }
      d3.select(nodes[index])
        .selectAll<SVGTextElement, { y: number; text: string; baseline: string }>(
          `.${pstyle.brushRange}`,
        )
        .data(labels)
        .join("text")
        .classed(pstyle.brushRange, true)
        .classed("pplot-brush-range", true)
        .attr("x", BRUSH_LABEL_X)
        .attr("y", (label) => label.y)
        .attr("dominant-baseline", (label) => label.baseline)
        .text((label) => label.text);
    });
  }

  compute_dimensions() {
    this.w = this.state.width - this.m[1] - this.m[3];
    this.h = this.state.height - this.m[0] - this.m[2];
    this.d3brush
      .extent([
        [-23, 0],
        [15, this.h],
      ])
      .on("brush", this.onBrushMove)
      .on("end", this.onBrushEnd);
    // Scale chart and canvas height
    const div = d3.select(mounted(this.root_ref));
    div.style("height", `${this.state.height}px`);

    div
      .selectAll("canvas")
      .attr("width", this.w)
      .attr("height", this.h)
      .style("padding", `${this.m.join("px ")}px`);
    this.xscale = d3
      .scalePoint<string>()
      .range([40, this.w - 40])
      .domain(this.state.dimensions);
    this.state.dimensions.forEach((d: string) => {
      this.setScaleRange(d);
    });
    this.highlightContext().lineWidth = HIGHLIGHT_WIDTH;
  }

  // transition ticks for reordering, rescaling and inverting
  update_ticks(d?: string, extent?: [number, number] | null): void {
    const svg = d3.select(mounted(this.svg_ref));
    // update brushes
    if (d) {
      const brush_el = svg
        .selectAll<SVGGElement, string>(`.${pstyle.brush}`)
        .filter((key) => key === d);
      this.d3brush.move(brush_el, extent ?? null);
    } else {
      // all ticks
      svg.selectAll<SVGGElement, string>(`.${pstyle.brush}`).call(this.d3brush);
    }

    // update axes
    d3.select(mounted(this.root_ref))
      .selectAll<SVGGElement, string>(`.${pstyle.axis}`)
      .each((dimension, i, nodes) => {
        const node = d3.select(nodes[i]);
        // transition axis numbers
        node.transition().duration(720).call(this.get_axis(dimension));
        node.selectAll(".tick text").style("font-weight", null).style("font-size", null);
      });
    this.redrawLines();
  }

  /** Geometry of the filtered rows, rebuilt only when they change. */
  geometry(): LineGeometry {
    if (this.lineGeometry === null || this.lineGeometry.rows !== this.props.rows_filtered) {
      this.lineGeometry = new LineGeometry(this.props.rows_filtered);
    }
    return this.lineGeometry;
  }

  brushMasks(): BrushMasks {
    if (this.masks === null || this.masks.rows !== this.props.rows_filtered) {
      this.masks = new BrushMasks(this.props.rows_filtered);
    }
    return this.masks;
  }

  /** Per-row flags (1 = drawn) of the rows whose lines are drawn. */
  selectionMask(geometry: LineGeometry): Uint8Array {
    const selected = this.drawnSelection ?? this.props.rows_selected;
    const memo = this.maskMemo;
    if (memo !== null && memo.geometry === geometry && memo.rows === selected) {
      return memo.mask;
    }
    const mask = new Uint8Array(geometry.rows.length);
    if (selected === geometry.rows) {
      mask.fill(1);
    } else {
      selected.forEach((row) => {
        mask[geometry.indexOf(row)] = 1;
      });
    }
    this.maskMemo = { geometry, rows: selected, mask };
    return mask;
  }

  /** The theme's color for deselected lines, read from the --hip-context-line token. */
  private contextColor(): RGB {
    const token = getComputedStyle(mounted(this.root_ref)).getPropertyValue("--hip-context-line");
    const parsed = d3.color(token.trim())?.rgb();
    if (!parsed) {
      throw new Error(`--hip-context-line is not a color: "${token}"`);
    }
    return { r: parsed.r, g: parsed.g, b: parsed.b };
  }

  /** Curves between axes unless the user chose straight lines, or "auto" meets many rows. */
  curvedLines(): boolean {
    if (this.state.lineShape === "auto") {
      return this.props.rows_filtered.length <= STRAIGHT_LINES_ABOVE_ROWS;
    }
    return this.state.lineShape === "curved";
  }

  /** Draws every line in one WebGL pass: the selection over the faint deselected rows. */
  private drawWithWebGL(webgl: WebGLLineRenderer): void {
    const geometry = this.geometry();
    const binning = this.props.color_binning;
    const mask = this.selectionMask(geometry);
    let selectedCount = 0;
    for (let i = 0; i < mask.length; ++i) {
      selectedCount += mask[i];
    }
    webgl.setRows(geometry.rows.length, geometry.order);
    webgl.setColors(geometry.colorBins(binning, this.props.colorby), binning.palette);
    webgl.setSelection(mask);
    webgl.draw({
      axes: this.state.dimensions.map((dimension) => ({
        x: this.position(dimension),
        pixels: geometry.pixels(
          dimension,
          this.yscale[dimension],
          this.props.params_def[dimension].numeric,
        ),
      })),
      width: this.w,
      height: this.h,
      curved: this.curvedLines(),
      selectedCount,
      contextCount: mask.length - selectedCount,
      contextColor: this.contextColor(),
      contextAlpha: this.props.dark ? CONTEXT_ALPHA_DARK : CONTEXT_ALPHA_LIGHT,
    });
  }

  /** Indices of the deselected rows, in draw order. */
  contextRows(geometry: LineGeometry, selectedRows: Uint32Array): Uint32Array {
    if (selectedRows === geometry.order) {
      return new Uint32Array(0);
    }
    const isSelected = new Uint8Array(geometry.rows.length);
    selectedRows.forEach((row) => {
      isSelected[row] = 1;
    });
    return geometry.order.filter((row) => isSelected[row] === 0);
  }

  /** Indices of the selected rows, in draw order. */
  drawnRows(geometry: LineGeometry, selected: ReadonlyArray<Datapoint>): Uint32Array {
    if (selected === geometry.rows) {
      return geometry.order;
    }
    const isSelected = new Uint8Array(geometry.rows.length);
    selected.forEach((row) => {
      isSelected[geometry.indexOf(row)] = 1;
    });
    return geometry.order.filter((row) => isSelected[row] === 1);
  }

  cancelDrawing(): void {
    if (this.drawingFrame !== null) {
      cancelAnimationFrame(this.drawingFrame);
      this.drawingFrame = null;
    }
  }

  /**
   * Draws polylines progressively within a frame-time budget. Canvas rasterizes
   * after the script yields, so the budget is enforced on measured frame
   * intervals: the number of lines per frame grows while frames stay under
   * budget and shrinks when they overrun. Everything is drawn in one pass when
   * it fits. A newer draw (higher `count`) supersedes this one.
   *
   * Rows are drawn in an order shuffled once per dataset, so no color ends up
   * systematically on top, and each frame strokes one path per color bin.
   * Pixels and color bins come from the cached LineGeometry.
   */
  /** Redraws the selected lines (all filtered rows before any selection exists). */
  redrawLines(): void {
    if (this.webgl !== null) {
      this.drawWithWebGL(this.webgl);
      return;
    }
    if (this.foreground === null) {
      return;
    }
    this.drawGeneration += 1;
    this.paths(
      this.drawnSelection ?? this.props.rows_selected,
      this.foreground,
      this.drawGeneration,
    );
  }

  paths(selected: ReadonlyArray<Datapoint>, ctx: CanvasRenderingContext2D, count: number): void {
    const opacity = Math.min(2 / selected.length ** 0.3, 1);
    const geometry = this.geometry();
    const selectedRows = this.drawnRows(geometry, selected);
    const contextRows = this.contextRows(geometry, selectedRows);
    // Composited "destination-over": the selection is drawn first and stays on top.
    const rows = new Uint32Array(selectedRows.length + contextRows.length);
    rows.set(selectedRows);
    rows.set(contextRows, selectedRows.length);
    const selectedCount = selectedRows.length;
    const { r, g, b } = this.contextColor();
    const contextAlpha =
      (this.props.dark ? CONTEXT_ALPHA_DARK : CONTEXT_ALPHA_LIGHT) *
      Math.min(1 / Math.max(1, contextRows.length) ** 0.3, 1);
    const contextCss = `rgba(${r}, ${g}, ${b}, ${contextAlpha})`;
    const n = rows.length;
    const curved = this.curvedLines();
    const binning = this.props.color_binning;
    const bins = geometry.colorBins(binning, this.props.colorby);
    const axes = this.state.dimensions.map((dimension) => ({
      x: this.xPosition(dimension),
      pixels: geometry.pixels(
        dimension,
        this.yscale[dimension],
        this.props.params_def[dimension].numeric,
      ),
    }));
    let i = 0;
    let previousFrame: number | null = null;
    let drawnLastFrame = 0;

    this.cancelDrawing();
    ctx.clearRect(0, 0, this.w + 1, this.h + 1);

    const drawFrame = (now: number): void => {
      this.drawingFrame = null;
      if (count < this.drawGeneration) {
        return;
      }
      if (previousFrame !== null && drawnLastFrame > 0) {
        const measured = (now - previousFrame) / drawnLastFrame;
        this.msPerLine = (this.msPerLine + measured) / 2;
      }
      previousFrame = now;
      const linesPerFrame = Math.min(
        MAX_LINES_PER_FRAME,
        Math.max(MIN_LINES_PER_FRAME, Math.round(FRAME_BUDGET_MS / this.msPerLine)),
      );
      const end = Math.min(i + linesPerFrame, n);
      drawnLastFrame = end - i;
      const rowsByBin = new Map<number, number[]>();
      for (; i < end; ++i) {
        const row = rows[i];
        const bin = i < selectedCount ? bins[row] : CONTEXT_BIN;
        const binRows = rowsByBin.get(bin);
        if (binRows === undefined) {
          rowsByBin.set(bin, [row]);
        } else {
          binRows.push(row);
        }
      }
      rowsByBin.forEach((binRows, bin) => {
        ctx.strokeStyle = bin === CONTEXT_BIN ? contextCss : binning.css(bin, opacity);
        ctx.beginPath();
        binRows.forEach((row) => {
          traceRow(ctx, axes, row, curved);
        });
        ctx.stroke();
      });
      if (i < n) {
        this.drawingFrame = requestAnimationFrame(drawFrame);
      }
    };
    drawFrame(performance.now());
  }

  brush_clear_all(): void {
    // Reset brushes - but only trigger call to "brush" once
    this.d3brush.on("brush", null).on("end", null);
    if (this.dimensions_dom !== null) {
      this.d3brush.move(
        this.dimensions_dom.selectAll<SVGGElement, string>(`.${pstyle.brush}`),
        null,
      );
    }
    this.d3brush.on("brush", this.onBrushMove).on("end", this.onBrushEnd);
    this.onBrushEnd();
  }

  remove_axis(d: string): void {
    const pd = this.props.params_def[d];
    if (pd !== undefined) {
      this.setState((prevState) => {
        const newHide = new Set(prevState.hide);
        newHide.add(d);
        return {
          hide: newHide,
        };
      });
    }
    this.setState((ps) => ({
      dimensions: _.difference(ps.dimensions, [d]),
    }));
  }

  can_restore_axis(d: string): boolean {
    const pd = this.props.params_def_unfiltered[d];
    return pd !== undefined && this.state.dimensions.indexOf(d) === -1 && !this.forceHideColumn(pd);
  }
  restore_axis(d: string): void {
    // Already displayed or not hidden
    if (!this.can_restore_axis(d)) {
      return;
    }
    this.setState((prevState) => {
      const newHide = new Set(prevState.hide);
      newHide.delete(d);
      return {
        hide: newHide,
        dimensions: prevState.dimensions.concat([d]),
      };
    });
  }
  restore_all_columns(): void {
    const toRestore = Array.from(this.state.hide).filter((d) => this.can_restore_axis(d));
    if (toRestore.length === 0) {
      return;
    }
    this.setState((prevState) => {
      const newHide = new Set(prevState.hide);
      const newDimensions = prevState.dimensions.slice();
      toRestore.forEach((d) => {
        newHide.delete(d);
        if (newDimensions.indexOf(d) === -1) {
          newDimensions.push(d);
        }
      });
      return {
        hide: newHide,
        dimensions: newDimensions,
      };
    });
  }
  getRestorableColumnsCount(): number {
    return Array.from(this.state.hide).filter((d) => this.can_restore_axis(d)).length;
  }

  can_hide_axis(d: string): boolean {
    return this.state.dimensions.indexOf(d) !== -1;
  }
  path(d: Datapoint, ctx: CanvasRenderingContext2D, color?: string): void {
    if (color) ctx.strokeStyle = color;
    ctx.beginPath();
    this.tracePath(d, ctx);
    ctx.stroke();
  }

  /**
   * Adds a row's polyline to the current path: Bezier segments between axes, a
   * short horizontal stub at each end, and a break around missing values.
   */
  tracePath(d: Datapoint, ctx: CanvasRenderingContext2D): void {
    const curved = this.curvedLines();
    let has_started = false;
    let x0 = 0;
    let y0 = 0;
    this.state.dimensions.forEach((p: string) => {
      const value = d[p];
      let err = value === undefined;
      if (!err && (value === "inf" || value === "-inf") && this.props.params_def[p].numeric) {
        err = true;
      }
      const x = this.xPosition(p);
      const y = this.yscale[p](value);
      if (Number.isNaN(y)) {
        err = true;
      }
      if (err) {
        if (has_started) {
          ctx.lineTo(x0 + 15, y0); // right edge
        }
        has_started = false;
        return;
      }
      if (!has_started) {
        x0 = x - 15;
        y0 = y;
        ctx.moveTo(x0, y0);
        has_started = true;
      }
      if (curved) {
        ctx.bezierCurveTo(x - 0.88 * (x - x0), y0, x - 0.12 * (x - x0), y, x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x0 = x;
      y0 = y;
    });
    if (has_started) {
      ctx.lineTo(x0 + 15, y0); // right edge
    }
  }
}
