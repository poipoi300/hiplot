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
import { createPortal } from "react-dom";
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
import controls from "../lib/controls.module.css";
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
import { ColumnPicker, type PickableColumn } from "./columnpicker";
import { LineGeometry } from "./geometry";
import pstyle from "./parallel.module.css";
import { type AxisSelection, BrushMasks } from "./selection";
import { monotoneSlope, SPLINE_HANDLE, splineParameter, splineY } from "./spline";
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

export interface ParallelPlotData extends HiPlotPluginData, ParallelPlotDisplayData {}

type BrushExtents = { [dimension: string]: [number, number] | null };
/** An axis title being long-pressed on a touch screen. */
interface LongPress {
  timer: number | null;
  fired: boolean;
}

/** Whether an element is a brush overlay or resize handle, where brushes are drawn or resized. */
function onBrushControl(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    target.closest(".pplot-brush") !== null &&
    !target.classList.contains("selection")
  );
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

/** A line's position on one axis; y is NaN where the row has no value. */
interface LinePoint {
  x: number;
  y: number;
}

/** Length of the horizontal stub at each end of a line, and around missing values. */
const STUB_PIXELS = 15;

/**
 * Adds one line to the current path: monotone spline or straight segments
 * between axes, a horizontal stub at each end, and a break around missing
 * values. The WebGL renderer draws the same shape.
 */
function traceLine(
  ctx: CanvasRenderingContext2D,
  points: ReadonlyArray<LinePoint>,
  curved: boolean,
): void {
  let previous: { x: number; y: number; slope: number } | null = null;
  for (let index = 0; index < points.length; ++index) {
    const point = points[index];
    if (Number.isNaN(point.y)) {
      if (previous !== null) {
        ctx.lineTo(previous.x + STUB_PIXELS, previous.y);
      }
      previous = null;
      continue;
    }
    const before = points[index - 1] ?? { x: Number.NaN, y: Number.NaN };
    const after = points[index + 1] ?? { x: Number.NaN, y: Number.NaN };
    const slope = curved
      ? monotoneSlope(before.x, before.y, point.x, point.y, after.x, after.y)
      : 0;
    if (previous === null) {
      ctx.moveTo(point.x - STUB_PIXELS, point.y);
      ctx.lineTo(point.x, point.y);
    } else if (curved) {
      const handle = SPLINE_HANDLE * (point.x - previous.x);
      ctx.bezierCurveTo(
        previous.x + handle,
        previous.y + handle * previous.slope,
        point.x - handle,
        point.y - handle * slope,
        point.x,
        point.y,
      );
    } else {
      ctx.lineTo(point.x, point.y);
    }
    previous = { x: point.x, y: point.y, slope };
  }
  if (previous !== null) {
    ctx.lineTo(previous.x + STUB_PIXELS, previous.y);
  }
}

/** Adds one row's line to the current path, from cached pixels. */
function traceRow(
  ctx: CanvasRenderingContext2D,
  axes: ReadonlyArray<AxisPixels>,
  row: number,
  curved: boolean,
): void {
  traceLine(
    ctx,
    axes.map((axis) => ({ x: axis.x, y: axis.pixels[row] })),
    curved,
  );
}

/** Axis titles: angle, start offset from the axis top, and longest drawn length. */
const TITLE_ANGLE_DEGREES = 35;
const TITLE_START_X = 4;
const TITLE_START_Y = -18;
const TITLE_MAX_PIXELS = 150;
/** The drag grip sits between the axis top and its title. */
const GRIP_OFFSET_Y = -9;
/**
 * Brush range tags: pills centered on the axis, outside the brush at its top
 * and bottom edges, or just inside an edge that leaves no room outside.
 */
const BRUSH_TAG_HEIGHT = 18;
const BRUSH_TAG_PADDING = 6;
const BRUSH_TAG_GAP = 3;
const BRUSH_TAG_MAX_PIXELS = 120;
/** The tag font, as parallel.module.css sets it on .brushRange. */
const BRUSH_TAG_FONT_PIXELS = 11.5;
const BRUSH_TAG_FONT_WEIGHT = 600;

/**
 * Horizontal layout. Tick labels sit `TICK_LABEL_OFFSET` left of their axis
 * and are cut to `TICK_LABEL_MAX_PIXELS`; neighboring axes stay at least
 * `AXIS_GAP` clear of the widest one, the plot scrolls sideways when they do
 * not fit, and the last axis keeps room for its whole title.
 */
const TICK_LABEL_OFFSET = 9;
/** Duration of the axis transitions after reordering, rescaling or inverting. */
const AXIS_TRANSITION_MS = 720;
const TICK_LABEL_MAX_PIXELS = 140;
const AXIS_GAP = 24;
const MIN_FIRST_AXIS_X = 40;
const LAST_TITLE_ROOM =
  TITLE_START_X + TITLE_MAX_PIXELS * Math.cos((TITLE_ANGLE_DEGREES * Math.PI) / 180) + 8;

/**
 * Cuts the first text node of `element` with an ellipsis until it is at most
 * `maxLength` pixels long, and returns the length it ends up with.
 */
function fitText(element: SVGTextElement, fullText: string, maxLength: number): number {
  // An empty text leaves no text node; a title child may follow the text.
  const first = element.firstChild;
  const textNode =
    first !== null && first.nodeType === Node.TEXT_NODE
      ? first
      : element.insertBefore(document.createTextNode(""), first);
  textNode.textContent = fullText;
  const fullLength = element.getComputedTextLength();
  if (fullLength <= maxLength) {
    return fullLength;
  }
  let low = 0;
  let high = fullText.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    textNode.textContent = `${fullText.slice(0, middle)}…`;
    if (element.getComputedTextLength() <= maxLength) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  textNode.textContent = `${fullText.slice(0, low)}…`;
  return element.getComputedTextLength();
}

/**
 * Like `fitText`, with a measuring function instead of the DOM: brush tags
 * change on every frame of a drag, and measuring SVG text forces a layout.
 */
export function fitWithMeasure(
  fullText: string,
  maxLength: number,
  measure: (text: string) => number,
): { text: string; width: number } {
  const fullWidth = measure(fullText);
  if (fullWidth <= maxLength) {
    return { text: fullText, width: fullWidth };
  }
  let low = 0;
  let high = fullText.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${fullText.slice(0, middle)}…`) <= maxLength) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const text = `${fullText.slice(0, low)}…`;
  return { text, width: measure(text) };
}

/** A value tag at one end of a brush; `y` is the tag's vertical center. */
interface BrushTag {
  edge: "top" | "bottom";
  y: number;
  text: string;
}

/** Widths of a drawn line, of a highlighted line and of the halo around it, in CSS pixels. */
const LINE_WIDTH = 1;
const HIGHLIGHT_WIDTH = 2.5;
const HALO_WIDTH = 7;
/** How far the pointer may be from a line to pick it. */
const HOVER_DISTANCE_PIXELS = 5;

/** Bin key of the deselected rows in the Canvas 2D fallback. */
const CONTEXT_BIN = -1;
/** "auto" switches to straight segments above this many rows, where curves blur into mush. */
const STRAIGHT_LINES_ABOVE_ROWS = 10_000;
/** Above this many rows, lines drawn during a drag are not anti-aliased. */
const LIGHT_DRAG_ROWS = 20_000;
/** Peak opacity of the deselected-rows layer per theme. */
const CONTEXT_ALPHA_LIGHT = 0.28;
const CONTEXT_ALPHA_DARK = 0.34;

export type LineShape = "auto" | "curved" | "straight";

/** The line shapes a user picks, drawn as the lines they make. */
const LINE_SHAPE_ICONS = {
  curved: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.5 12.5C7 12.5 9 3.5 14.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  straight: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.5 12.5 14.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
} as const;
const isLineShape = (value: unknown): value is LineShape =>
  value === "auto" || value === "curved" || value === "straight";

/** Target frame interval while lines draw progressively (60 Hz). */
const FRAME_BUDGET_MS = 16;
const INITIAL_MS_PER_LINE = 0.05;
const MIN_LINES_PER_FRAME = 100;
const MAX_LINES_PER_FRAME = 50_000;

/** Row counts in the toolbar. */
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

const TOP_MARGIN_PIXELS = 120;
const H_MARGIN_PIXELS = 20;
export class ParallelPlot extends React.Component<ParallelPlotData, ParallelPlotState> {
  /** Lays the plot out again, now (relayout) or once resizing settles (on_resize). */
  relayout: (() => void) | null = null;
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
  /** Device pixels per CSS pixel the canvases were last sized for. */
  pixelRatio = 1;

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

  /** Widest tick label drawn, which sets the minimum spacing between axes. */
  tickLabelWidth = 40;

  // Rendering
  root_ref = React.createRef<HTMLDivElement>();
  /**
   * The plot scrolls virtually: it stays at the frame's width and draws the
   * part of the axes in view, shifted by `scrollLeft`, so only what is on
   * screen is painted and drawn. A scrollbar under it, over a spacer as wide
   * as all the axes, sets the offset; so do horizontal wheel and trackpad
   * gestures over the plot.
   */
  plot_ref = React.createRef<HTMLDivElement>();
  scroller_ref = React.createRef<HTMLDivElement>();
  spacer_ref = React.createRef<HTMLDivElement>();
  scrollLeft = 0;
  /** Width of all the axes, in plot coordinates. */
  contentW = 0;
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
    this.root_ref.current?.removeEventListener("wheel", this.onWheel);
    d3.select(this.svgg_ref.current).selectAll("*").remove();
    this.cancelDrawing();
    this.webgl?.dispose();
    this.webgl = null;
    this.props.context_menu_ref?.current?.removeCallbacks(this);
    this.cancelBrushMove();
    this.sendBrushExtents.cancel();
    this.fitTickLabelsAfterTransition.cancel();
    if (this.scrollFrame !== null) {
      cancelAnimationFrame(this.scrollFrame);
    }
  }
  componentDidUpdate(prevProps: ParallelPlotData, prevState: ParallelPlotState) {
    if (prevState.height !== this.state.height || prevState.width !== this.state.width) {
      this.on_resize?.();
    }
    // Scales first: laying the axes out reads the scale of every dimension,
    // including the ones just shown.
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
    if (prevState.dimensions !== this.state.dimensions && this.dimensions_dom !== null) {
      this.dimensions_dom.filter((p) => this.state.dimensions.indexOf(p) === -1).remove();
      this.dimensions_dom = this.dimensions_dom.filter(
        (p) => this.state.dimensions.indexOf(p) !== -1,
      );
      if (prevState.dimensions.length !== this.state.dimensions.length) {
        // Spacing and plot width follow the number of axes.
        this.compute_dimensions();
        this.dimensions_dom.selectAll<SVGGElement, string>(`.${pstyle.brush}`).call(this.d3brush);
      }
      this.xscale.domain(this.state.dimensions);
      const g = d3.select(this.svgg_ref.current).selectAll<SVGGElement, string>(".dimension");
      const translate = (p: string) => `translate(${this.position(p)})`;
      if (this.state.dragging) {
        g.attr("transform", translate);
      } else {
        g.transition().attr("transform", translate);
      }

      this.update_ticks();
      this.updateAxisTitlesAnglesAndFontSize();
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
    // Saved last, once the change applied: a display rebuilt after an error
    // starts from the last state that worked.
    if (prevState.invert !== this.state.invert) {
      this.props.persistentState.set("invert", Array.from(this.state.invert));
    }
    if (prevState.hide !== this.state.hide) {
      this.props.persistentState.set("hide", Array.from(this.state.hide));
    }
    if (prevState.lineShape !== this.state.lineShape) {
      this.props.persistentState.set("lineShape", this.state.lineShape);
    }
    if (prevState.order !== this.state.order) {
      this.props.persistentState.set("order", this.state.order);
    }
  }
  /** Whether a brush or an axis is being dragged (see `antialiasedLines`). */
  private interacting = false;
  onBrushStart = (): void => {
    this.interacting = true;
    this.clearHover();
  };
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
    this.interacting = false;
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
    const limit = COUNT_FORMAT.format(STRAIGHT_LINES_ABOVE_ROWS);
    const rows = COUNT_FORMAT.format(this.props.rows_filtered.length);
    const shapes: { shape: LineShape; label: string; title: string; icon?: React.ReactElement }[] =
      [
        {
          shape: "auto",
          label: "Auto",
          title: this.curvedLines()
            ? `Auto: curved for ${rows} rows (straight above ${limit}, where curves blur into one mass)`
            : `Auto: straight for ${rows} rows (curved up to ${limit})`,
        },
        {
          shape: "curved",
          label: "Curved",
          title: "Curved: smooth monotone splines through the axes",
          icon: LINE_SHAPE_ICONS.curved,
        },
        {
          shape: "straight",
          label: "Straight",
          title: "Straight: straight segments between axes",
          icon: LINE_SHAPE_ICONS.straight,
        },
      ];
    const toolbar = (
      <div className={pstyle.toolbar}>
        <fieldset className={controls.segmented} aria-label="Line shape">
          {shapes.map(({ shape, label, title, icon }) => (
            <button
              key={shape}
              type="button"
              title={title}
              aria-label={label}
              aria-pressed={this.state.lineShape === shape}
              className={icon === undefined ? undefined : controls.iconSegment}
              onClick={() => this.setState({ lineShape: shape })}
            >
              {icon ?? label}
            </button>
          ))}
        </fieldset>
        <ColumnPicker
          columns={this.pickableColumns()}
          shown={new Set(this.state.dimensions)}
          onShow={(names) => this.setColumnsShown(names, true)}
          onHide={(names) => this.setColumnsShown(names, false)}
        />
        <button
          type="button"
          className={controls.button}
          disabled={!this.state.brushed}
          title="Clear every brush and select all rows"
          onClick={() => this.brush_clear_all()}
        >
          Reset brushes
        </button>
      </div>
    );
    const slot = this.props.header_toolbar;
    return (
      <>
        {slot === undefined ? toolbar : slot !== null && createPortal(toolbar, slot)}
        <ResizableH initialHeight={this.state.height} onResize={this.onResize}>
          <div
            ref={this.root_ref}
            className={`${pstyle["parallel-plot-chart"]} pplot-root`}
            style={{ height: this.state.height }}
          >
            <div ref={this.plot_ref} className={pstyle.plot}>
              <canvas ref={this.foreground_ref}></canvas>
              <canvas ref={this.highlighted_ref}></canvas>
              <svg
                ref={this.svg_ref}
                role="img"
                aria-label="Parallel coordinates axes"
                onMouseMove={this.onPointerMove}
                onMouseLeave={this.clearHover}
              >
                <g ref={this.svgg_ref}></g>
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
            <div
              ref={this.scroller_ref}
              className={pstyle.scroller}
              onScroll={this.onScroll}
              data-testid="pplot-scroller"
            >
              <div ref={this.spacer_ref} className={pstyle.spacer} />
            </div>
          </div>
        </ResizableH>
      </>
    );
  }

  /** The row under the pointer is found every frame at most, from the cached pixels. */
  private hoverFrame: number | null = null;
  onPointerMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    // A highlight would hide the lines a brush is being drawn or resized over;
    // a placed brush's band still highlights the line under the pointer.
    if (event.buttons !== 0 || onBrushControl(event.target)) {
      this.clearHover();
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
    const curved = this.curvedLines();
    const gap = axes[right].x - left.x;
    const fraction = Math.max(0, Math.min(1, (x - left.x) / gap));
    const t = splineParameter(fraction);
    // Neighbor axes set the spline's slopes; a missing neighbor flattens it.
    const neighborPixels = (index: number): Float32Array | null => {
      const neighbor = axes[index];
      if (!curved || neighbor === undefined) {
        return null;
      }
      return geometry.pixels(
        neighbor.dimension,
        this.yscale[neighbor.dimension],
        this.props.params_def[neighbor.dimension].numeric,
      );
    };
    const beforePixels = neighborPixels(right - 2);
    const afterPixels = neighborPixels(right + 1);
    const xBefore = axes[right - 2]?.x ?? Number.NaN;
    const xAfter = axes[right + 1]?.x ?? Number.NaN;
    const mask = this.selectionMask(geometry);
    let nearest = -1;
    let nearestDistance = HOVER_DISTANCE_PIXELS;
    for (let row = 0; row < mask.length; ++row) {
      if (mask[row] === 0) {
        continue;
      }
      const yLeft = leftPixels[row];
      const yRight = rightPixels[row];
      let lineY = yLeft + (yRight - yLeft) * fraction;
      if (curved) {
        const yBefore = beforePixels === null ? Number.NaN : beforePixels[row];
        const yAfter = afterPixels === null ? Number.NaN : afterPixels[row];
        const slopeLeft = monotoneSlope(xBefore, yBefore, left.x, yLeft, axes[right].x, yRight);
        const slopeRight = monotoneSlope(left.x, yLeft, axes[right].x, yRight, xAfter, yAfter);
        lineY = splineY(t, gap, yLeft, slopeLeft, yRight, slopeRight);
      }
      const distance = Math.abs(lineY - y);
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
    this.setState({ hover: { x: x + this.m[3] - this.scrollLeft, y: y + this.m[0], text } });
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
    // Not passive: a horizontal gesture over the plot scrolls the axes, not the page.
    mounted(me.root_ref).addEventListener("wheel", me.onWheel, { passive: false });
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
            me.interacting = true;
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
                    pos: Math.min(me.contentW, Math.max(0, prevState.dragging.pos + eventdx)),
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
                if (me.state.dragging.pos < 12 || me.state.dragging.pos > me.contentW - 12) {
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
            me.interacting = false;
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
            } else if (me.state.dragging.pos < 12 || me.state.dragging.pos > me.contentW - 12) {
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
      me.fitTickLabels();
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

    // Lays the plot out again for its size and the widest tick label.
    this.relayout = () => {
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
      me.fitTickLabels();

      me.redrawLines();
      this.props.sendMessage("height_changed", () => null);
    };
    this.on_resize = _.debounce(this.relayout, 100);

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
    const svgWidth = this.axisLayout().contentWidth;
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
      fitText(this, fullText, maxLength);
    });
  }

  /**
   * Cuts tick labels longer than TICK_LABEL_MAX_PIXELS (their full text goes
   * in a tooltip) and lays the axes out again when the widest label changed.
   */
  private fitTickLabels(): void {
    let widest = 0;
    this.dimensions_dom
      ?.selectAll<SVGTextElement, AxisValue>(`.${pstyle.axis} .tick text`)
      .each(function (this: SVGTextElement) {
        const fullText = this.firstChild?.textContent ?? "";
        const length = fitText(this, fullText, TICK_LABEL_MAX_PIXELS);
        if (this.firstChild?.textContent !== fullText) {
          d3.select(this).append("title").text(fullText);
        }
        widest = Math.max(widest, length);
      });
    if (Math.abs(widest - this.tickLabelWidth) > 0.5) {
      // At once, so the first picture already has its final layout. The next
      // pass measures the same labels, which ends the recursion.
      this.tickLabelWidth = widest;
      this.relayout?.();
    }
  }

  /**
   * Where the axes go: the first axis leaves room for its tick labels, axes
   * are spread over the available width but never closer than their labels
   * allow, and the last one keeps room for its title. Wider than the
   * container, the plot scrolls sideways.
   */
  axisLayout(): { first: number; spacing: number; contentWidth: number } {
    const count = this.state.dimensions.length;
    const labelRoom = this.tickLabelWidth + TICK_LABEL_OFFSET;
    const first = Math.max(MIN_FIRST_AXIS_X, labelRoom + 4 - this.m[3]);
    const fixed = this.m[3] + first + LAST_TITLE_ROOM + this.m[1];
    const spacing =
      count <= 1 ? 0 : Math.max(labelRoom + AXIS_GAP, (this.state.width - fixed) / (count - 1));
    return {
      first,
      spacing,
      contentWidth: Math.max(this.state.width, Math.ceil(fixed + spacing * (count - 1))),
    };
  }

  /** Value tags at the top and bottom edges of each brush. */
  private updateBrushRangeLabels(extents: BrushExtents): void {
    const tagCenter = (edge: "top" | "bottom", pixel: number): number => {
      const offset = BRUSH_TAG_GAP + BRUSH_TAG_HEIGHT / 2;
      if (edge === "top") {
        return pixel - offset < BRUSH_TAG_HEIGHT / 2 ? pixel + offset : pixel - offset;
      }
      return pixel + offset > this.h + this.m[2] - BRUSH_TAG_HEIGHT / 2
        ? pixel - offset
        : pixel + offset;
    };
    this.dimensions_dom?.each((dimension, index, nodes) => {
      const extent = extents[dimension];
      const scale = this.yscale[dimension];
      const labels: BrushTag[] = [];
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
        const [topText, bottomText] =
          range.type === ParamType.CATEGORICAL
            ? [range.values[0] ?? "none", range.values[range.values.length - 1] ?? "none"]
            : [valueAt(top), valueAt(bottom)];
        labels.push(
          { edge: "top", y: tagCenter("top", top), text: topText },
          { edge: "bottom", y: tagCenter("bottom", bottom), text: bottomText },
        );
      }
      const tags = d3
        .select(nodes[index])
        .selectAll<SVGGElement, BrushTag>(`.${pstyle.brushTag}`)
        .data(labels, (label) => label.edge)
        .join((enter) => {
          const tag = enter.append("g").classed(pstyle.brushTag, true);
          tag
            .append("rect")
            .attr("height", BRUSH_TAG_HEIGHT)
            .attr("rx", BRUSH_TAG_HEIGHT / 2);
          tag
            .append("text")
            .classed(pstyle.brushRange, true)
            .classed("pplot-brush-range", true)
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central");
          return tag;
        })
        .attr("data-edge", (label) => label.edge)
        .attr("transform", (label) => `translate(0, ${label.y})`);
      const measure = this.tagTextMeasure();
      tags.each(function (this: SVGGElement, label) {
        const text = d3.select(this).select<SVGTextElement>("text").node();
        if (text === null) {
          throw new Error("Brush tag lost its text");
        }
        const fitted = fitWithMeasure(label.text, BRUSH_TAG_MAX_PIXELS, measure);
        text.textContent = fitted.text;
        const width = fitted.width + 2 * BRUSH_TAG_PADDING;
        d3.select(this)
          .select("rect")
          .attr("x", -width / 2)
          .attr("y", -BRUSH_TAG_HEIGHT / 2)
          .attr("width", width);
      });
    });
  }

  private tagMeasure: ((text: string) => number) | null = null;
  /** Measures brush tag text on a canvas in the tags' font, without a DOM layout. */
  private tagTextMeasure(): (text: string) => number {
    if (this.tagMeasure !== null) {
      return this.tagMeasure;
    }
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) {
      throw new Error("Canvas 2D is not available");
    }
    const family = getComputedStyle(mounted(this.svg_ref)).fontFamily;
    context.font = `${BRUSH_TAG_FONT_WEIGHT} ${BRUSH_TAG_FONT_PIXELS}px ${family}`;
    this.tagMeasure = (text) => context.measureText(text).width;
    return this.tagMeasure;
  }

  /** Shifts the axes by the scroll offset; lines follow on the next draw. */
  placeAxes(): void {
    mounted(this.svgg_ref).setAttribute(
      "transform",
      `translate(${this.m[3] - this.scrollLeft}, ${this.m[0]})`,
    );
  }
  private scrollFrame: number | null = null;
  /** Horizontal wheel and trackpad gestures, or shift+wheel, scroll the axes. */
  onWheel = (event: WheelEvent): void => {
    const scroller = mounted(this.scroller_ref);
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const delta = horizontal ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (delta === 0 || scroller.scrollWidth <= scroller.clientWidth) {
      return;
    }
    event.preventDefault();
    scroller.scrollLeft += delta;
  };
  onScroll = (): void => {
    const left = mounted(this.scroller_ref).scrollLeft;
    if (left === this.scrollLeft) {
      return;
    }
    this.scrollLeft = left;
    this.placeAxes();
    this.clearHover();
    if (this.scrollFrame === null) {
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        this.redrawLines();
      });
    }
  };

  compute_dimensions() {
    const layout = this.axisLayout();
    const scroller = mounted(this.scroller_ref);
    const plot = mounted(this.plot_ref);
    mounted(this.spacer_ref).style.width = `${layout.contentWidth}px`;
    // The scrollbar, when the axes need one, takes its height from the plot.
    const overflows = layout.contentWidth > this.state.width;
    scroller.style.display = overflows ? "block" : "none";
    const scrollbar = overflows ? scroller.offsetHeight : 0;
    const height = this.state.height - scrollbar;
    plot.style.width = `${this.state.width}px`;
    plot.style.height = `${height}px`;
    this.scrollLeft = overflows ? scroller.scrollLeft : 0;
    d3.select(mounted(this.svg_ref)).attr("width", this.state.width).attr("height", height);
    this.placeAxes();
    this.w = this.state.width - this.m[1] - this.m[3];
    this.contentW = layout.contentWidth - this.m[1] - this.m[3];
    this.h = height - this.m[0] - this.m[2];
    this.d3brush
      .extent([
        [-23, 0],
        [15, this.h],
      ])
      .on("start", this.onBrushStart)
      .on("brush", this.onBrushMove)
      .on("end", this.onBrushEnd);
    // Scale chart and canvas height
    const div = d3.select(mounted(this.root_ref));
    div.style("height", `${this.state.height}px`);

    // Canvases hold the plot at device resolution; drawing code works in CSS pixels.
    this.pixelRatio = window.devicePixelRatio;
    div
      .selectAll("canvas")
      .attr("width", Math.round(this.w * this.pixelRatio))
      .attr("height", Math.round(this.h * this.pixelRatio))
      .style("width", `${this.w}px`)
      .style("height", `${this.h}px`)
      .style("padding", `${this.m.join("px ")}px`);
    for (const context of [this.highlighted, this.foreground]) {
      context?.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    }
    if (this.foreground !== null) {
      // Resizing a canvas resets its context: the selection stays above the context rows.
      this.foreground.globalCompositeOperation = "destination-over";
    }
    this.xscale = d3
      .scalePoint<string>()
      .range([layout.first, layout.first + layout.spacing * (this.state.dimensions.length - 1)])
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
        node.transition().duration(AXIS_TRANSITION_MS).call(this.get_axis(dimension));
        node.selectAll(".tick text").style("font-weight", null).style("font-size", null);
      });
    this.fitTickLabelsAfterTransition();
    this.redrawLines();
  }
  /** Tick texts change when the axis transition starts; they are measured once it ended. */
  fitTickLabelsAfterTransition = _.debounce(() => this.fitTickLabels(), AXIS_TRANSITION_MS + 40);

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

  /**
   * Lines are anti-aliased except while a brush or an axis is dragged over
   * more than LIGHT_DRAG_ROWS rows: anti-aliasing doubles the fragments of a
   * frame, which then no longer fits the frame budget. The picture is
   * anti-aliased again as soon as the drag ends.
   */
  antialiasedLines(): boolean {
    return !this.interacting || this.props.rows_filtered.length <= LIGHT_DRAG_ROWS;
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
        x: this.position(dimension) - this.scrollLeft,
        pixels: geometry.pixels(
          dimension,
          this.yscale[dimension],
          this.props.params_def[dimension].numeric,
        ),
      })),
      width: this.w,
      height: this.h,
      lineWidth: LINE_WIDTH,
      pixelRatio: this.pixelRatio,
      curved: this.curvedLines(),
      antialiased: this.antialiasedLines(),
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
      x: this.xPosition(dimension) - this.scrollLeft,
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
  /** Every column that can be an axis, in the order of the experiment's columns. */
  pickableColumns(): PickableColumn[] {
    return Object.keys(this.props.params_def_unfiltered)
      .filter((name) => !this.forceHideColumn(this.props.params_def_unfiltered[name]))
      .map((name) => {
        const pd = this.props.params_def_unfiltered[name];
        return { name, label: labelTextFromHtml(pd.label_html, pd.name) };
      });
  }
  /**
   * Shows columns as axes (appended at the right) or hides them. A column
   * whose axis cannot be built is refused with a toast, and nothing changes.
   */
  setColumnsShown(names: ReadonlyArray<string>, shown: boolean): void {
    if (shown) {
      for (const name of names) {
        const refusal = this.axisRefusal(name);
        if (refusal !== null) {
          this.props.notify(
            `Could not show "${name}": ${refusal}. The columns were left as they were.`,
          );
          return;
        }
      }
    }
    this.setState((prevState) => {
      const hide = new Set(prevState.hide);
      if (!shown) {
        for (const name of names) {
          hide.add(name);
        }
        return { hide, dimensions: _.difference(prevState.dimensions, names) };
      }
      const added = names.filter(
        (name) =>
          !prevState.dimensions.includes(name) &&
          !this.forceHideColumn(this.props.params_def_unfiltered[name]),
      );
      for (const name of added) {
        hide.delete(name);
      }
      return { hide, dimensions: prevState.dimensions.concat(added) };
    });
  }
  /** Why `name` cannot be drawn as an axis, or null when it can. */
  private axisRefusal(name: string): string | null {
    try {
      return this.createScale(name) === null ? "the column is not in the experiment" : null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
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
    const points = this.state.dimensions.map((dimension): LinePoint => {
      const value = d[dimension];
      const missing =
        value === undefined ||
        ((value === "inf" || value === "-inf") && this.props.params_def[dimension].numeric);
      return {
        x: this.xPosition(dimension) - this.scrollLeft,
        y: missing ? Number.NaN : this.yscale[dimension](value),
      };
    });
    traceLine(ctx, points, this.curvedLines());
  }
}
