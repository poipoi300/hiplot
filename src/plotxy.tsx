/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import $ from "jquery";
import React from "react";
import _ from "underscore";
import { ContextMenu } from "./contextmenu";
import style from "./hiplot.module.css";
import { create_d3_scale, type ParamDef, type ParamScale } from "./infertypes";
import { IS_MOBILE } from "./lib/browsercompat";
import controls from "./lib/controls.module.css";
import { getLogScaleTickValues, type Scale } from "./lib/d3_scales";
import { labelTextFromHtml } from "./lib/escape";
import { fitColor } from "./lib/fitcolor";
import { powerOfTenLabels } from "./lib/numberformat";
import { mounted } from "./lib/refs";
import { ResizableH } from "./lib/resizable";
import { isString, readState } from "./lib/savedstate";
import { valueFormatter } from "./parallel/axisformat";
import { type FitMode, isFitMode, type ScatterStats, scatterStats } from "./plots/scatterstats";
import type { HiPlotPluginData } from "./plugin";
import { formatParameter } from "./stats/distributions";
import { type Datapoint, type DatapointValue, ParamType } from "./types";

// DISPLAYS_DATA_DOC_BEGIN
// Corresponds to values in the dict of `exp.display_data(hip.Displays.XY)`
export interface PlotXYDisplayData {
  axis_x: string | null;
  axis_y: string | null;
  lines_thickness: number;
  lines_opacity: number | null;
  dots_thickness: number; // Circle radius in pixel
  dots_highlighed_thickness: number; // Circle radius in pixel
  dots_opacity: number | null;

  // Default height in pixels
  height?: number;
}
// DISPLAYS_DATA_DOC_END

interface PlotXYProps extends HiPlotPluginData, PlotXYDisplayData {
  /** Closes the plot when it is one of several (see ScatterPlots), which then owns its axes. */
  onClose?: () => void;
}

const HIGHLIGHT_PARENT = "parent";
const HIGHLIGHT_CHILDREN = "children";
const HIGHLIGHT_TYPES = [HIGHLIGHT_PARENT, HIGHLIGHT_CHILDREN] as const;
type HighlightType = (typeof HIGHLIGHT_TYPES)[number];

const isHighlightType = (value: unknown): value is HighlightType =>
  HIGHLIGHT_TYPES.some((highlightType) => highlightType === value);
const isStringOrNull = (value: unknown): value is string | null =>
  value === null || isString(value);

interface PlotXYState extends PlotXYDisplayData {
  width: number;
  initialHeight: number;
  height: number;
  hover_uid: string | null;
  highlightType: HighlightType;
  /** How two numeric columns are summarized: a straight fit or binned means. */
  fitMode: FitMode;
  /** Correlations and the fit of the selected rows, as last drawn. */
  stats: ScatterStats | null;
}

const COUNT_FORMAT = new Intl.NumberFormat("en-US");
/** Distinguishes the clip paths of the fits of several scatters on one page. */
let fitClipCount = 0;
/** Width of the caps at the ends of a category mean's interval. */
const CAP_PIXELS = 6;

/** A correlation coefficient to two decimals, or a dash when there is none. */
const coefficient = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : "–");

type AxisName = "axis_x" | "axis_y";
type SvgSelection = d3.Selection<SVGSVGElement, unknown, null, undefined>;
type AxisGroup = d3.Selection<SVGGElement, unknown, null, undefined>;
type NumberFormatter = (value: number) => string;

interface AxisTicks {
  count: number;
  values: number[] | null;
  format: NumberFormatter | null;
}

interface DisplayedPoint {
  layerX: number;
  layerY: number;
  dp: Datapoint;
}

interface DrawStyle {
  lines_color: string;
  dots_color: string;
  lines_width: number;
  dots_thickness: number;
  remember?: boolean;
}

function canvas2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("2D canvas context is unavailable");
  }
  return context;
}

/** `d3.min([value, 1])`: a NaN value is ignored. */
function opacityCappedAtOne(value: number): number {
  return Number.isNaN(value) ? 1 : Math.min(value, 1);
}

function brushRectangle(selection: d3.BrushSelection): [[number, number], [number, number]] {
  const [first, second] = selection;
  if (typeof first === "number" || typeof second === "number") {
    throw new Error("Expected the 2D selection of a brush on both axes");
  }
  return [first, second];
}

/** Room left of the y tick labels, and their offsets from the axis line. */
const Y_LABEL_PADDING = 8;
const Y_AXIS_OFFSET = 10;
const Y_TICK_LABEL_OFFSET = 9;
/** The tick font, as `.plotxy-graph-svg` sets it. */
const TICK_FONT_PIXELS = 11;
/** The y tick labels never take more than this share of the plot's width. */
const MAX_LABEL_SHARE = 0.4;

let tickMeasureContext: CanvasRenderingContext2D | null = null;
/** The width of the widest of `labels` in the tick font, measured without a layout. */
function widestLabel(labels: ReadonlyArray<string>, fontFamily: string): number {
  tickMeasureContext ??= document.createElement("canvas").getContext("2d");
  if (tickMeasureContext === null) {
    throw new Error("Canvas 2D is not available");
  }
  tickMeasureContext.font = `${TICK_FONT_PIXELS}px ${fontFamily}`;
  const context = tickMeasureContext;
  return labels.reduce((widest, label) => Math.max(widest, context.measureText(label).width), 0);
}

function axisGenerator<Domain extends d3.AxisDomain>(
  orientation: "left" | "bottom",
  scale: d3.AxisScale<Domain>,
): d3.Axis<Domain> {
  return orientation === "left" ? d3.axisLeft(scale) : d3.axisBottom(scale);
}

function buildAxis(
  orientation: "left" | "bottom",
  scale: Scale,
  ticks: AxisTicks,
  tickSizeInner: number,
): d3.Axis<number> | d3.Axis<string> {
  if (scale.kind === "continuous") {
    const axis = axisGenerator<number>(orientation, scale)
      .ticks(ticks.count)
      .tickSizeInner(tickSizeInner);
    if (ticks.values !== null) {
      axis.tickValues(ticks.values);
    }
    if (ticks.format !== null) {
      axis.tickFormat(ticks.format);
    }
    return axis;
  }
  const axis = axisGenerator<string>(orientation, scale)
    .ticks(ticks.count)
    .tickSizeInner(tickSizeInner);
  const format = ticks.format;
  if (format !== null) {
    axis.tickFormat((category) => format(Number(category)));
  }
  return axis;
}

interface PlotXYInternal {
  svg: SvgSelection;
  clear_canvas: () => void;
  update_axis: () => void;
  recompute_scale: () => void;
  draw_selected_rows: () => void;
  draw_highlighted: () => void;
  on_resize: (() => void) & _.Cancelable;
}

export class PlotXY extends React.Component<PlotXYProps, PlotXYState> {
  plot: PlotXYInternal | null = null;

  root_ref = React.createRef<HTMLDivElement>();
  container_ref = React.createRef<HTMLDivElement>();
  canvas_lines_ref = React.createRef<HTMLCanvasElement>();
  canvas_highlighted_ref = React.createRef<HTMLCanvasElement>();
  plotXYcontextMenuRef = React.createRef<ContextMenu>();

  constructor(props: PlotXYProps) {
    super(props);
    const height =
      props.window_state.height ||
      props.height ||
      Math.min(Math.max(document.body.clientHeight - 540, 240), 500);

    // Load default X/Y axis
    const plotConfig: PlotXYDisplayData = props;
    function get_default_axis(axis_name: AxisName): string | null {
      // A plot among several (it has `onClose`) gets its axes from the container.
      const value =
        props.onClose !== undefined
          ? props[axis_name]
          : readState(props.persistentState, axis_name, isStringOrNull, props[axis_name]);
      if (value !== null && props.params_def[value] === undefined) {
        return null;
      }
      return value;
    }

    this.state = {
      ...plotConfig,
      axis_x: get_default_axis("axis_x"),
      axis_y: get_default_axis("axis_y"),
      width: 0,
      height: height,
      initialHeight: height,
      hover_uid: null,
      highlightType: readState(
        props.persistentState,
        "highlightType",
        isHighlightType,
        HIGHLIGHT_PARENT,
      ),
      fitMode: readState(props.persistentState, "fit", isFitMode, "linear"),
      stats: null,
    };
  }
  static defaultProps = {
    axis_x: null,
    axis_y: null,
    lines_thickness: 1.2,
    lines_opacity: null,
    dots_highlighed_thickness: 5.0,
    dots_thickness: 1.4,
    dots_opacity: null,

    data: {},
  };
  componentDidMount() {
    const contextMenu = this.props.context_menu_ref?.current;
    if (!contextMenu || this.props.onClose !== undefined) {
      return;
    }
    contextMenu.addCallback((column, cm) => {
      const contextmenu = $(cm);
      contextmenu.append($('<div class="dropdown-divider"></div>'));
      contextmenu.append($(`<h6 class="dropdown-header">${this.props.name}</h6>`));
      (["axis_x", "axis_y"] as const).forEach((dat, index) => {
        const label = `Set as ${["X", "Y"][index]} axis`;
        const option = $('<a class="dropdown-item" href="#">').text(label);
        if (this.state[dat] === column) {
          option.addClass("disabled").css("pointer-events", "none");
        }
        option.click((event) => {
          if (index === 0) {
            this.setState({ axis_x: column });
          } else {
            this.setState({ axis_y: column });
          }
          event.preventDefault();
        });
        contextmenu.append(option);
      });
    }, this);
  }
  mountPlotXY(): PlotXYInternal {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const me = this;

    const plotContextMenu = mounted(me.plotXYcontextMenuRef);
    plotContextMenu.removeCallbacks(this);
    plotContextMenu.addCallback((_column, cm) => {
      const contextmenu = $(cm);
      HIGHLIGHT_TYPES.forEach((dat) => {
        const option = $('<a class="dropdown-item" href="#">').text(`Highlight: ${dat}`);
        if (me.state.highlightType === dat) {
          option.addClass("disabled").css("pointer-events", "none");
        }
        option.click((event) => {
          me.setState({ highlightType: dat });
          event.preventDefault();
        });
        contextmenu.append(option);
      });
    }, me);
    const div = d3.select(mounted(this.root_ref));
    const svg = div.select<SVGSVGElement>("svg");
    let currently_displayed: DisplayedPoint[] = [];
    let zoom_brush: d3.BrushBehavior<unknown>;

    // The fit of the selected rows, over the dots and under the zoom brush.
    const fitClipId = `plotxy-fit-clip-${++fitClipCount}`;
    const fitClip = svg.append("clipPath").attr("id", fitClipId).append("rect");
    const fitLayer = svg
      .append("g")
      .attr("class", style.plotxyFit)
      .attr("clip-path", `url(#${fitClipId})`);

    // Lines
    const graph_lines = canvas2dContext(mounted(this.canvas_lines_ref));
    graph_lines.globalCompositeOperation = "destination-over";

    // Highlights
    const highlights = canvas2dContext(mounted(this.canvas_highlighted_ref));
    highlights.globalCompositeOperation = "destination-over";

    // The left margin follows the widest y tick label (see recompute_scale).
    const margin = { top: 40, right: 20, bottom: 70, left: 75 };
    let x_scale: ParamScale;
    let y_scale: ParamScale;
    let yAxis: (g: AxisGroup) => void;
    let xAxis: (g: AxisGroup) => void;
    let x_scale_orig: ParamScale;
    let y_scale_orig: ParamScale;

    function redraw_axis_and_rerender() {
      redraw_axis();
      clear_canvas();
      me.drawSelectedThrottled();
    }
    function create_scale(param: string, range: readonly [number, number]): ParamScale {
      const scale = create_d3_scale(me.props.params_def[param]);
      scale.range(range);
      return scale;
    }
    /**
     * One notation for every tick of an axis, as the parallel plot writes
     * the same column: powers of ten alike on log axes, one fixed or
     * scientific notation on linear ones.
     */
    function getTickFormatter(
      param: string,
      scale: ParamScale,
      tickValues: number[] | null,
      tickCount: number,
    ): NumberFormatter | null {
      const paramDef = me.props.params_def[param];
      if (scale.kind !== "continuous" || paramDef.type === ParamType.TIMESTAMP) {
        return null;
      }
      const values = valueFormatter(scale, tickCount);
      if (paramDef.type !== ParamType.NUMERICLOG || tickValues === null) {
        return values;
      }
      const powerLabels = powerOfTenLabels(tickValues);
      const labels = new Map(tickValues.map((power, index) => [power, powerLabels[index]]));
      return (value) => labels.get(value) ?? values(value);
    }
    /** The y tick labels as drawn, to size the left margin to the widest. */
    function yTickLabels(scale: ParamScale, ticks: AxisTicks): string[] {
      if (scale.kind !== "continuous") {
        return scale.domain().map(String);
      }
      const values = ticks.values ?? scale.ticks(ticks.count);
      const format = ticks.format ?? scale.tickFormat(ticks.count);
      return values.map((value) => format(value));
    }
    function getTickValues(param: string, scale: Scale, approxTickCount: number): number[] | null {
      const paramDef = me.props.params_def[param];
      if (!paramDef || paramDef.type !== ParamType.NUMERICLOG || scale.kind !== "continuous") {
        return null;
      }
      return getLogScaleTickValues(scale.domain(), approxTickCount);
    }
    function currentContextMenu(): ContextMenu | null {
      return me.props.context_menu_ref?.current ?? null;
    }
    function append_axis_label(
      g: AxisGroup,
      pd: ParamDef,
      placement: { x: number; y: number; anchor: "start" | "middle" },
    ) {
      const label = g
        .append("text")
        .attr("x", placement.x)
        .attr("y", placement.y)
        .attr("text-anchor", placement.anchor)
        .attr("font-weight", "bold")
        .attr("fill", "currentColor")
        .classed(style.axisLabelText, true)
        .classed("plotxy-label", true)
        .text(labelTextFromHtml(pd.label_html, pd.name));
      label.append("title").text(IS_MOBILE ? "Long-press for options" : "Right click for options");

      let longPressTimer: number | null = null;
      let longPressFired = false;
      label
        .on("contextmenu", (event: MouseEvent) => {
          const contextMenu = currentContextMenu();
          if (contextMenu === null) {
            return;
          }
          contextMenu.show(event.pageX, event.pageY, pd.name);
          event.preventDefault();
          event.stopPropagation();
        })
        .on("touchstart", (event: TouchEvent) => {
          if (currentContextMenu() === null) return;
          longPressFired = false;
          const touch = event.touches[0];
          longPressTimer = window.setTimeout(() => {
            currentContextMenu()?.show(touch.pageX, touch.pageY, pd.name);
            longPressFired = true;
            longPressTimer = null;
          }, 500);
        })
        .on("touchend touchcancel touchmove", (event: TouchEvent) => {
          if (longPressTimer !== null) {
            window.clearTimeout(longPressTimer);
            longPressTimer = null;
          }
          if (longPressFired) {
            event.preventDefault();
            event.stopPropagation();
          }
        });
    }
    function redraw_axis() {
      svg.selectAll(".axis_render").remove();
      svg.selectAll(".brush").remove();
      svg.attr("viewBox", [0, 0, me.state.width, me.state.height].join(","));
      svg.append("g").attr("class", "axis_render").call(xAxis);
      svg.append("g").attr("class", "axis_render").call(yAxis);
      svg.append("g").attr("class", "brush").call(zoom_brush);
    }
    function recompute_scale(force: boolean = false) {
      if (!force && !me.isEnabled()) {
        return;
      }
      const axes = me.requireAxes();
      const insideGraphMargin = Math.max(
        me.props.dots_thickness,
        me.props.dots_highlighed_thickness,
        0,
      );
      y_scale = create_scale(axes.y, [
        me.state.height - margin.bottom - insideGraphMargin,
        margin.top + insideGraphMargin,
      ]);
      const yTickCount = 1 + me.state.height / 40;
      const yTickValues = getTickValues(axes.y, y_scale, yTickCount);
      const yTicks: AxisTicks = {
        count: yTickCount,
        values: yTickValues,
        format: getTickFormatter(axes.y, y_scale, yTickValues, yTickCount),
      };
      const widest = widestLabel(
        yTickLabels(y_scale, yTicks),
        getComputedStyle(mounted(me.root_ref)).fontFamily,
      );
      margin.left = Math.ceil(
        Math.min(
          me.state.width * MAX_LABEL_SHARE,
          widest + Y_TICK_LABEL_OFFSET + Y_AXIS_OFFSET + Y_LABEL_PADDING,
        ),
      );
      x_scale = create_scale(axes.x, [
        margin.left + insideGraphMargin,
        me.state.width - margin.right - insideGraphMargin,
      ]);
      x_scale_orig = x_scale;
      y_scale_orig = y_scale;
      const xTickCount = 1 + me.state.width / 80;
      const xTickValues = getTickValues(axes.x, x_scale, xTickCount);
      const xTicks: AxisTicks = {
        count: xTickCount,
        values: xTickValues,
        format: getTickFormatter(axes.x, x_scale, xTickValues, xTickCount),
      };
      zoom_brush = d3
        .brush()
        .extent([
          [margin.left, margin.top],
          [me.state.width - margin.right, me.state.height - margin.bottom],
        ])
        .on("end", brushended);

      yAxis = (g) => {
        const pd = me.props.params_def[me.requireAxes().y];
        g.attr("transform", `translate(${margin.left - Y_AXIS_OFFSET},0)`)
          .call(buildAxis("left", y_scale, yTicks, margin.left + margin.right - me.state.width))
          .call((axisGroup) => axisGroup.select(".domain").remove())
          .call((axisGroup) => append_axis_label(axisGroup, pd, { x: 13, y: 25, anchor: "start" }))
          .attr("font-size", null);
      };
      xAxis = (g) => {
        const pd = me.props.params_def[me.requireAxes().x];
        const centerX = (margin.left + me.state.width - margin.right) / 2;
        g.attr("transform", `translate(0,${me.state.height - margin.bottom})`)
          .call(buildAxis("bottom", x_scale, xTicks, margin.bottom + margin.top - me.state.height))
          // Make odd ticks below (to prevent overlap when very long labels)
          .call((axisGroup) =>
            axisGroup.selectAll<SVGGElement, unknown>(".tick").each(function (
              this: SVGGElement,
              _tickValue: unknown,
              i: number,
            ) {
              const line = this.children[0] as SVGLineElement;
              if (
                this.childElementCount === 2 &&
                (this.children[1] as SVGTextElement).textLength.baseVal.value &&
                line.nodeName === "line"
              ) {
                const y2 = line.getAttribute("y2");
                if (y2 === null) {
                  throw new Error("Axis tick line has no y2 attribute");
                }
                this.transform.baseVal.getItem(0).matrix.f += 20 * (i % 2);
                line.setAttribute("y2", `${parseFloat(y2) - 20 * (i % 2)}`);
              }
            }),
          )
          .call((axisGroup) =>
            append_axis_label(axisGroup, pd, { x: centerX, y: 45, anchor: "middle" }),
          )
          .attr("font-size", null);
      };
      div
        .selectAll("canvas")
        .attr("width", me.state.width - margin.left - margin.right)
        .attr("height", me.state.height - margin.top - margin.bottom);
      div.selectAll("svg").attr("width", me.state.width).attr("height", me.state.height);
      div.style("height", `${me.state.height}px`);
      div
        .selectAll("canvas")
        .style("margin", `${margin.top}px ${margin.right}px ${margin.bottom}px ${margin.left}px`);

      redraw_axis();
    }
    function on_move() {
      const position = $(mounted(me.root_ref)).position();
      const pos_top = position.top;
      const pos_left = position.left;
      div.selectAll("canvas").style("top", `${pos_top}px`).style("left", `${pos_left}px`);
      svg.style("top", `${pos_top}px`).style("left", `${pos_left}px`);
    }
    function zoomed_scale(
      current: ParamScale,
      param: string,
      range: readonly [number, number],
      pixelStart: number,
      pixelEnd: number,
    ): ParamScale {
      if (current.kind !== "continuous") {
        return current;
      }
      const zoomed = create_scale(param, range);
      if (zoomed.kind !== "continuous") {
        throw new Error(`Column "${param}" changed from a continuous to a categorical scale`);
      }
      zoomed.domain([current.invert(pixelStart), current.invert(pixelEnd)]);
      return zoomed;
    }
    function brushended(event: d3.D3BrushEvent<unknown>) {
      if (event.selection === null) {
        if (x_scale === x_scale_orig && y_scale === y_scale_orig) {
          return;
        }
        x_scale = x_scale_orig;
        y_scale = y_scale_orig;
      } else {
        const axes = me.requireAxes();
        const [[left, top], [right, bottom]] = brushRectangle(event.selection);
        x_scale = zoomed_scale(
          x_scale,
          axes.x,
          [margin.left, me.state.width - margin.right],
          left,
          right,
        );
        y_scale = zoomed_scale(
          y_scale,
          axes.y,
          [me.state.height - margin.bottom, margin.top],
          bottom,
          top,
        );
      }
      redraw_axis_and_rerender();
    }
    on_move();

    function hover(hoverTarget: SvgSelection) {
      const dot = svg.append("g").attr("display", "none");

      dot.append("circle").attr("r", 2.5);

      dot.append("text").classed(style.plotxyHoverText, true).attr("text-anchor", "middle");
      dot.select("text").attr("y", -8);

      if ("ontouchstart" in document)
        hoverTarget
          .style("-webkit-tap-highlight-color", "transparent")
          .on("touchmove", moved)
          .on("touchstart", entered)
          .on("touchend", left);
      else hoverTarget.on("mousemove", moved).on("mouseenter", entered).on("mouseleave", left);

      function moved(event: MouseEvent) {
        // Only process hover within the plot area (inside margins).
        // This allows touch-scrolling over axis labels on mobile.
        const ex = event.layerX,
          ey = event.layerY;
        if (
          ex < margin.left ||
          ex > me.state.width - margin.right ||
          ey < margin.top ||
          ey > me.state.height - margin.bottom
        ) {
          left();
          return;
        }
        event.preventDefault();
        let closest: DisplayedPoint | null = null;
        let closest_dist: number | null = null;
        for (const displayed of currently_displayed) {
          const dist = (displayed.layerX - ex) ** 2 + (displayed.layerY - ey) ** 2;
          if (closest_dist === null || dist < closest_dist) {
            closest_dist = dist;
            closest = displayed;
          }
        }
        if (closest === null) {
          dot.attr("transform", `translate(${ex},${ey})`);
          dot.select("text").text("No point found?!");
          return;
        }
        me.setState({
          hover_uid: closest.dp.uid,
        });
        dot.attr("transform", `translate(${closest.layerX},${closest.layerY})`);
        dot.select("text").text(me.props.render_row_text(closest.dp));
      }

      function entered() {
        dot.attr("display", null);
      }

      function left() {
        me.setState({
          hover_uid: null,
        });
        dot.attr("display", "none");
      }
    }

    hover(svg);

    function render_dp(
      dp: Datapoint,
      ctx: CanvasRenderingContext2D,
      c: DrawStyle,
      axes: { x: string; y: string },
    ) {
      if (c.lines_color) ctx.strokeStyle = c.lines_color;
      if (c.dots_color) ctx.fillStyle = c.dots_color;
      if (c.lines_width) ctx.lineWidth = c.lines_width;
      const pdx = me.props.params_def[axes.x];
      const pdy = me.props.params_def[axes.y];
      function is_err(value: DatapointValue, scaled_value: number, def: ParamDef) {
        return (
          value === undefined ||
          value === null ||
          Number.isNaN(scaled_value) ||
          (def.numeric && (value === "inf" || value === "-inf"))
        );
      }
      function render_point_position(point: Datapoint) {
        let x = x_scale(point[axes.x]);
        let y = y_scale(point[axes.y]);
        x -= margin.left;
        y -= margin.top;

        const err = is_err(point[axes.x], x, pdx) || is_err(point[axes.y], y, pdy);
        if (err) {
          return null;
        }
        if (c.remember) {
          currently_displayed.push({
            layerX: x + margin.left,
            layerY: y + margin.top,
            dp: point,
          });
        }
        return { x: x, y: y };
      }
      const pos = render_point_position(dp);
      if (pos === null) {
        return;
      }
      if (dp.from_uid && c.lines_width > 0.0) {
        const dp_prev = me.props.dp_lookup[dp.from_uid];
        if (dp_prev) {
          const prev_pos = render_point_position(dp_prev);
          if (prev_pos !== null) {
            ctx.beginPath();
            ctx.moveTo(prev_pos.x, prev_pos.y);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
          }
        } else {
          console.log(`DataPoint with id ${dp.from_uid} not found (dp.from_uid)`, dp);
        }
      }
      if (c.dots_thickness > 0) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, c.dots_thickness, 0, 2 * Math.PI, true);
        ctx.fill();
      }
    }

    /** Draws the fit of `stats` with the current (possibly zoomed) scales. */
    function draw_fit(stats: ScatterStats): void {
      fitLayer.selectAll("*").remove();
      // Fits stay inside the plot area, where their values are on the axes.
      fitClip
        .attr("x", margin.left)
        .attr("y", margin.top)
        .attr("width", Math.max(0, me.state.width - margin.left - margin.right))
        .attr("height", Math.max(0, me.state.height - margin.top - margin.bottom));
      const color = fitColor(me.props.color_binning.palette, me.props.dark ? "dark" : "light");
      if (stats.kind === "numeric" && stats.fit !== null) {
        const points = stats.fit.points
          .map(([x, y]): [number, number] => [x_scale(x), y_scale(y)])
          .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
        fitLayer
          .append("path")
          .attr("class", style.plotxyFitLine)
          .attr("data-testid", "scatter-fit")
          .attr("stroke", color)
          .attr("d", d3.line()(points));
        return;
      }
      if (stats.kind !== "categorical") {
        return;
      }
      for (const mean of stats.means) {
        const along = stats.categoriesOn === "x" ? x_scale : y_scale;
        const across = stats.categoriesOn === "x" ? y_scale : x_scale;
        const at = along(mean.category);
        const [center, low, high] = [mean.mean, mean.lower, mean.upper].map((value) =>
          across(value),
        );
        const place = (a: number, b: number): [number, number] =>
          stats.categoriesOn === "x" ? [a, b] : [b, a];
        const group = fitLayer
          .append("g")
          .attr("data-testid", "scatter-category-mean")
          .attr("stroke", color)
          .attr("fill", color);
        if (Number.isFinite(low) && Number.isFinite(high)) {
          const interval = [
            [place(at, low), place(at, high)],
            [place(at - CAP_PIXELS / 2, low), place(at + CAP_PIXELS / 2, low)],
            [place(at - CAP_PIXELS / 2, high), place(at + CAP_PIXELS / 2, high)],
          ];
          for (const [[x1, y1], [x2, y2]] of interval) {
            group
              .append("line")
              .attr("class", style.plotxyFitLine)
              .attr("x1", x1)
              .attr("y1", y1)
              .attr("x2", x2)
              .attr("y2", y2);
          }
        }
        const [cx, cy] = place(at, center);
        group.append("circle").attr("class", style.plotxyFitMean).attr("cx", cx).attr("cy", cy);
      }
    }

    function draw_selected_rows() {
      if (!me.isEnabled()) {
        return;
      }
      clear_canvas();
      const axes = me.requireAxes();
      const stats = scatterStats(
        me.props.rows_selected,
        { column: axes.x, type: x_scale.paramType },
        { column: axes.y, type: y_scale.paramType },
        me.state.fitMode,
      );
      me.setState({ stats });
      draw_fit(stats);
      const xp_config = me.props;
      const area = (me.state.height * me.state.width) / 400000;
      const lines_opacity =
        xp_config.lines_opacity !== null
          ? xp_config.lines_opacity
          : opacityCappedAtOne((3 * area) / me.props.rows_selected.length ** 0.3);
      const dots_opacity =
        xp_config.dots_opacity !== null
          ? xp_config.dots_opacity
          : opacityCappedAtOne((4 * area) / me.props.rows_selected.length ** 0.3);
      me.props.rows_selected.forEach((dp: Datapoint) => {
        render_dp(
          dp,
          graph_lines,
          {
            lines_color: me.props.get_color_for_row(dp, lines_opacity),
            lines_width: xp_config.lines_thickness,
            dots_color: me.props.get_color_for_row(dp, dots_opacity),
            dots_thickness: xp_config.dots_thickness,
            remember: true,
          },
          axes,
        );
      });
    }

    function clear_canvas() {
      graph_lines.clearRect(0, 0, me.state.width, me.state.height);
      highlights.clearRect(0, 0, me.state.width, me.state.height);
      currently_displayed = [];
    }

    function lookupParent(dp: Datapoint): Datapoint[] {
      if (dp.from_uid === null) {
        return [];
      }
      const nextDp = me.props.dp_lookup[dp.from_uid];
      return nextDp === undefined ? [] : [nextDp];
    }
    let childrenLookup: { [parent_uid: string]: Datapoint[] } = {};
    function lookupChildren(dp: Datapoint): Datapoint[] {
      const next = childrenLookup[dp.uid];
      return next ? next : [];
    }
    // Draw highlights
    function draw_highlighted() {
      if (!me.isEnabled()) {
        return;
      }
      const axes = me.requireAxes();
      const highlighted = me.props.rows_highlighted;
      highlights.clearRect(0, 0, me.state.width, me.state.height);
      d3.select(mounted(me.canvas_highlighted_ref)).style("opacity", "0");
      d3.select(mounted(me.canvas_lines_ref)).style("opacity", "1.0");
      if (!highlighted.length) {
        return;
      }
      d3.select(mounted(me.canvas_highlighted_ref)).style("opacity", "1.0");
      d3.select(mounted(me.canvas_lines_ref)).style("opacity", "0.5");
      childrenLookup = {};
      if (me.state.highlightType === HIGHLIGHT_CHILDREN) {
        // Pre-compute graph of children - TODO: maybe we could cache that
        me.props.rows_filtered.forEach((dp) => {
          if (dp.from_uid !== null) {
            if (childrenLookup[dp.from_uid] === undefined) {
              childrenLookup[dp.from_uid] = [dp];
            } else {
              childrenLookup[dp.from_uid].push(dp);
            }
          }
        });
      }
      const lookupNextDp =
        me.state.highlightType === HIGHLIGHT_CHILDREN ? lookupChildren : lookupParent;

      // Find all runs + parents
      let todo = new Set(highlighted);
      const allHighlighted = new Set<Datapoint>();
      while (todo.size) {
        const oldTodo = todo;
        todo = new Set();
        oldTodo.forEach((dp) => {
          if (allHighlighted.has(dp)) {
            return;
          }
          allHighlighted.add(dp);
          lookupNextDp(dp).forEach((newDp) => {
            todo.add(newDp);
          });
        });
      }
      const binning = me.props.color_binning;
      allHighlighted.forEach((dp) => {
        const bin = binning.binOf(dp[me.props.colorby]);
        render_dp(
          dp,
          highlights,
          {
            lines_color: binning.css(bin, 1.0),
            lines_width: 4,
            dots_color: binning.css(bin, 0.8),
            dots_thickness: me.props.dots_highlighed_thickness,
          },
          axes,
        );
      });
    }

    // Change axis
    function update_axis() {
      recompute_scale(true);
      clear_canvas();
      me.drawSelectedThrottled();
    }
    update_axis();

    // Initial lines right now
    draw_selected_rows();
    me.drawSelectedThrottled.cancel();

    return {
      svg: svg,
      clear_canvas: clear_canvas,
      update_axis: update_axis,
      recompute_scale: recompute_scale,
      draw_selected_rows: draw_selected_rows,
      draw_highlighted: draw_highlighted,
      on_resize: _.debounce(() => {
        if (me.isEnabled()) {
          recompute_scale();
          draw_selected_rows();
        }
      }, 150),
    };
  }
  onResize = _.debounce((height: number, width: number): void => {
    if (this.state.height !== height || this.state.width !== width) {
      this.setState({ height: height, width: width });
    }
  }, 100);
  disable(): void {
    if (this.props.onClose !== undefined) {
      this.props.onClose();
      return;
    }
    this.setState({ axis_x: null, axis_y: null, height: this.state.initialHeight });
  }
  render() {
    if (!this.isEnabled()) {
      return [];
    }
    return (
      <>
        {this.renderChart()}
        {this.state.width > 0 && this.renderStats()}
      </>
    );
  }
  renderChart(): React.ReactNode {
    return (
      <ResizableH
        initialHeight={this.state.height}
        onResize={this.onResize}
        onRemove={this.disable.bind(this)}
      >
        <ContextMenu ref={this.plotXYcontextMenuRef} />
        {this.state.width > 0 && (
          <div
            role="application"
            aria-label="XY plot, right click for highlight options"
            onContextMenu={this.plotXYcontextMenuRef.current?.onContextMenu}
            ref={this.root_ref}
            style={{ height: this.state.height }}
          >
            <canvas ref={this.canvas_lines_ref} style={{ position: "absolute" }}></canvas>
            <canvas ref={this.canvas_highlighted_ref} style={{ position: "absolute" }}></canvas>
            <svg
              className={style["plotxy-graph-svg"]}
              style={{ position: "absolute" }}
              role="img"
              aria-label="XY scatter plot"
            ></svg>
          </div>
        )}
      </ResizableH>
    );
  }

  /** The correlations of the selected rows and what the drawn fit is. */
  renderStats(): React.ReactNode {
    const stats = this.state.stats;
    if (stats === null) {
      return null;
    }
    const { x: axis_x, y: axis_y } = this.requireAxes();
    const color = fitColor(this.props.color_binning.palette, this.props.dark ? "dark" : "light");
    const swatch = <span className={style.fitSwatch} style={{ background: color }} />;
    const term = (column: string, logged: boolean) => (logged ? `log₁₀(${column})` : column);
    let description: React.ReactNode;
    if (stats.kind === "none") {
      description = stats.reason;
    } else if (stats.kind === "categorical") {
      const [categories, values] = stats.categoriesOn === "x" ? [axis_x, axis_y] : [axis_y, axis_x];
      description = (
        <>
          {swatch}
          {stats.logged ? "Geometric mean" : "Mean"} of {values} per {categories}, with its 95%
          interval (Student t){stats.logged ? ", fitted in log space" : ""}
        </>
      );
    } else if (stats.fit === null) {
      description = "No fit: too few rows with both values";
    } else if (stats.fit.mode === "linear") {
      const { intercept, slope, r2 } = stats.fit;
      description = (
        <>
          {swatch}
          Least squares: {term(axis_y, stats.logY)} = {formatParameter(intercept).replace("-", "−")}{" "}
          {slope < 0 ? "−" : "+"} {formatParameter(Math.abs(slope))}·{term(axis_x, stats.logX)}, R²{" "}
          {r2.toFixed(2)}
        </>
      );
    } else {
      description = (
        <>
          {swatch}
          Mean of {term(axis_y, stats.logY)} in 12 equal bins of {term(axis_x, stats.logX)}
        </>
      );
    }
    return (
      <div className={style.scatterStats} data-testid="scatter-stats">
        {stats.kind === "numeric" && (
          <table className={style.correlationTable} aria-label="Correlation of the selected rows">
            <thead>
              <tr>
                <th scope="col">Pearson r</th>
                <th scope="col">Spearman ρ</th>
                <th scope="col">n</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{coefficient(stats.summary.pearson)}</td>
                <td>{coefficient(stats.summary.spearman)}</td>
                <td>{COUNT_FORMAT.format(stats.summary.n)}</td>
              </tr>
            </tbody>
          </table>
        )}
        {stats.kind === "categorical" && (
          <span className={style.scatterStatsCount}>n {COUNT_FORMAT.format(stats.n)}</span>
        )}
        <span className={style.scatterFit}>{description}</span>
        {stats.kind === "numeric" && (
          <fieldset className={controls.segmented} aria-label="Fit">
            {(
              [
                ["linear", "Linear"],
                ["binned", "Binned means"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={this.state.fitMode === mode}
                onClick={() => this.setState({ fitMode: mode })}
              >
                {label}
              </button>
            ))}
          </fieldset>
        )}
      </div>
    );
  }
  componentWillUnmount() {
    if (this.plot) {
      this.plot.clear_canvas();
      this.plot.on_resize.cancel();
      this.plot.svg.selectAll("*").remove();
    }
    this.props.context_menu_ref?.current?.removeCallbacks(this);
    this.drawSelectedThrottled.cancel();
    this.onResize.cancel();
    this.plotXYcontextMenuRef.current?.removeCallbacks(this);
  }
  isEnabled() {
    return this.state.axis_x !== null && this.state.axis_y !== null;
  }
  /** The selected X and Y columns; only valid while the plot is enabled. */
  requireAxes(): { x: string; y: string } {
    const { axis_x, axis_y } = this.state;
    if (axis_x === null || axis_y === null) {
      throw new Error("PlotXY axes were read while the plot is disabled");
    }
    return { x: axis_x, y: axis_y };
  }
  drawSelected = (): void => {
    if (this.plot) {
      this.plot.draw_selected_rows();
    }
  };
  drawSelectedThrottled = _.throttle(this.drawSelected, 100);
  componentDidUpdate(prevProps: PlotXYProps, prevState: Readonly<PlotXYState>) {
    let anyAxisChanged = false;
    (["axis_x", "axis_y"] as const).forEach((d) => {
      if (prevState[d] !== this.state[d]) {
        this.props.persistentState.set(d, this.state[d]);
        anyAxisChanged = true;
      }
    });
    if (this.state.highlightType !== prevState.highlightType) {
      this.props.persistentState.set("highlightType", this.state.highlightType);
    }
    if (this.state.fitMode !== prevState.fitMode) {
      this.props.persistentState.set("fit", this.state.fitMode);
      this.drawSelectedThrottled();
    }
    if (this.state.width === 0) {
      return; // Loading...
    }
    if (this.isEnabled() && !this.plot) {
      this.plot = this.mountPlotXY();
    }
    if (prevState.height !== this.state.height || prevState.width !== this.state.width) {
      if (this.plot) {
        this.plot.on_resize();
        this.props.sendMessage("height_changed", () => null);
      }
    }
    if (!this.isEnabled()) {
      if (this.plot !== null) {
        this.plot = null;
        this.props.sendMessage("height_changed", () => null);
      }
      if (this.state.hover_uid !== null) {
        this.setState({
          hover_uid: null,
        });
      }
    } else if (anyAxisChanged) {
      if (this.plot === null) {
        throw new Error("PlotXY is enabled but its plot was never mounted");
      }
      this.plot.update_axis();
      this.props.sendMessage("height_changed", () => null);
    }
    if (this.state.hover_uid !== prevState.hover_uid) {
      if (this.state.hover_uid === null) {
        this.props.setHighlighted([]);
      } else {
        this.props.setHighlighted([this.props.dp_lookup[this.state.hover_uid]]);
      }
    }

    // Check if data changed
    if (this.plot) {
      const axes = this.requireAxes();
      let scaleRecomputed = false;
      const colorByChange =
        this.props.params_def[this.props.colorby] !== prevProps.params_def[prevProps.colorby];
      if (
        this.props.params_def[axes.x] !== prevProps.params_def[axes.x] ||
        this.props.params_def[axes.y] !== prevProps.params_def[axes.y]
      ) {
        this.plot.recompute_scale();
        scaleRecomputed = true;
      }
      if (
        this.props.rows_selected !== prevProps.rows_selected ||
        scaleRecomputed ||
        colorByChange
      ) {
        this.drawSelectedThrottled();
      }
      if (
        this.props.rows_highlighted !== prevProps.rows_highlighted ||
        scaleRecomputed ||
        colorByChange ||
        this.state.highlightType !== prevState.highlightType
      ) {
        this.plot.draw_highlighted();
      }
    }
    this.props.window_state.height = this.state.height;
  }
}
