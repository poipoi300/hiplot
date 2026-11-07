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
import { create_d3_scale } from "./infertypes";
import { IS_MOBILE } from "./lib/browsercompat";
import { getLogScaleTickValues } from "./lib/d3_scales";
import { ResizableH } from "./lib/resizable";
import type { HiPlotPluginData } from "./plugin";
import { type Datapoint, ParamType } from "./types";

// DISPLAYS_DATA_DOC_BEGIN
// Corresponds to values in the dict of `exp.display_data(hip.Displays.XY)`
export interface PlotXYDisplayData {
  axis_x: string | null;
  axis_y: string | null;
  lines_thickness: number;
  lines_opacity: number;
  dots_thickness: number; // Circle radius in pixel
  dots_highlighed_thickness: number; // Circle radius in pixel
  dots_opacity: number;

  // Default height in pixels
  height?: number;
}
// DISPLAYS_DATA_DOC_END

interface PlotXYProps extends HiPlotPluginData, PlotXYDisplayData {}

interface PlotXYState extends PlotXYDisplayData {
  width: number;
  initialHeight: number;
  height: number;
  hover_uid: string | null;
  highlightType: string;
}

const HIGHLIGHT_PARENT = "parent";
const HIGHLIGHT_CHILDREN = "children";

function labelTextFromHtml(html: string, fallback: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html || "";
  const text = (tmp.textContent || tmp.innerText || "").trim();
  return text.length ? text : fallback;
}

interface PlotXYInternal {
  clear_canvas: () => void;
  update_axis: () => void;
  recompute_scale: () => void;
  draw_selected_rows: () => void;
  draw_highlighted: () => void;
  on_resize: (() => void) & _.Cancelable;
}

export class PlotXY extends React.Component<PlotXYProps, PlotXYState> {
  plot: PlotXYInternal;

  svg: any;

  root_ref: React.RefObject<HTMLDivElement> = React.createRef();
  container_ref: React.RefObject<HTMLDivElement> = React.createRef();
  canvas_lines_ref: React.RefObject<HTMLCanvasElement> = React.createRef();
  canvas_highlighted_ref: React.RefObject<HTMLCanvasElement> = React.createRef();
  plotXYcontextMenuRef = React.createRef<ContextMenu>();

  constructor(props: PlotXYProps) {
    super(props);
    let height: number;
    if (props.window_state.height) {
      height = props.window_state.height;
    } else if (props.height) {
      height = props.height;
    } else {
      height = d3.min([d3.max([document.body.clientHeight - 540, 240]), 500]);
    }

    // Load default X/Y axis
    const plotConfig = this.props as PlotXYDisplayData;
    function get_default_axis(axis_name: string) {
      let value = props.persistentState.get(axis_name, props[axis_name]);
      if (value === undefined) {
        value = null;
      }
      if (value != null && props.params_def[value] === undefined) {
        return null;
      }
      return value;
    }

    const state = {
      ...plotConfig,
      axis_x: get_default_axis("axis_x"),
      axis_y: get_default_axis("axis_y"),
      width: 0,
      height: height,
      initialHeight: height,
    };
    this.state = {
      ...state,
      hover_uid: null,
      highlightType: this.props.persistentState.get("highlightType", HIGHLIGHT_PARENT),
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
    if (this.props.context_menu_ref && this.props.context_menu_ref.current) {
      this.props.context_menu_ref.current.addCallback((column, cm) => {
        const contextmenu = $(cm);
        contextmenu.append($('<div class="dropdown-divider"></div>'));
        contextmenu.append($(`<h6 class="dropdown-header">${this.props.name}</h6>`));
        ["axis_x", "axis_y"].forEach((dat, index) => {
          const label = "Set as " + ["X", "Y"][index] + " axis";
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
  }
  mountPlotXY(this: PlotXY): PlotXYInternal {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const me = this;

    me.plotXYcontextMenuRef.current.removeCallbacks(this);
    me.plotXYcontextMenuRef.current.addCallback((column, cm) => {
      const contextmenu = $(cm);
      [HIGHLIGHT_PARENT, HIGHLIGHT_CHILDREN].forEach((dat) => {
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
    const div = d3.select(this.root_ref.current);
    me.svg = div.select("svg");
    let currently_displayed = [];
    let zoom_brush: d3.BrushBehavior<unknown>;

    // Lines
    const graph_lines = this.canvas_lines_ref.current.getContext("2d");
    graph_lines.globalCompositeOperation = "destination-over";

    // Highlights
    const highlights = this.canvas_highlighted_ref.current.getContext("2d");
    highlights.globalCompositeOperation = "destination-over";

    const margin = { top: 40, right: 20, bottom: 70, left: 75 };
    let x_scale: any;
    let y_scale: any;
    let yAxis: any;
    let xAxis: any;
    let x_scale_orig: d3.AxisScale<d3.AxisDomain>, y_scale_orig: d3.AxisScale<d3.AxisDomain>;

    function redraw_axis_and_rerender() {
      redraw_axis();
      clear_canvas();
      me.drawSelectedThrottled();
    }
    function create_scale(param: string, range) {
      const scale = create_d3_scale(me.props.params_def[param]);
      scale.range(range);
      return scale;
    }
    function getTickFormatter(param: string, scale: any): ((d: any) => string) | null {
      const paramDef = me.props.params_def[param];
      if (!paramDef) {
        return null;
      }
      if (paramDef.type === ParamType.TIMESTAMP) {
        return null;
      }
      if (paramDef.ticks_format) {
        return d3.format(paramDef.ticks_format);
      }
      const isNumericLike =
        paramDef.type === ParamType.NUMERIC ||
        paramDef.type === ParamType.NUMERICLOG ||
        paramDef.type === ParamType.NUMERICPERCENTILE;
      if (!isNumericLike || typeof scale.domain !== "function") {
        return null;
      }
      const domain = scale.domain();
      if (!Array.isArray(domain)) {
        return null;
      }
      const maxAbsDomain = d3.max(
        domain.map((v: any) => Math.abs(Number(v))).filter((v: number) => Number.isFinite(v)),
      );
      if (maxAbsDomain === undefined || maxAbsDomain < 1e6) {
        return null;
      }
      return d3.format(".3~e");
    }
    function getTickValues(param: string, scale: any, approxTickCount: number): any[] | null {
      const paramDef = me.props.params_def[param];
      if (
        !paramDef ||
        paramDef.type !== ParamType.NUMERICLOG ||
        typeof scale.domain !== "function"
      ) {
        return null;
      }
      return getLogScaleTickValues(scale.domain(), approxTickCount);
    }
    function redraw_axis() {
      me.svg.selectAll(".axis_render").remove();
      me.svg.selectAll(".brush").remove();
      me.svg.attr("viewBox", [0, 0, me.state.width, me.state.height]);
      me.svg.append("g").attr("class", "axis_render").call(xAxis);
      me.svg.append("g").attr("class", "axis_render").call(yAxis);
      me.svg.append("g").attr("class", "brush").call(zoom_brush);
    }
    function recompute_scale(force: boolean = false) {
      if (!force && !me.isEnabled()) {
        return;
      }
      const insideGraphMargin = Math.max(
        me.props.dots_thickness,
        me.props.dots_highlighed_thickness,
        0,
      );
      x_scale_orig = x_scale = create_scale(me.state.axis_x, [
        margin.left + insideGraphMargin,
        me.state.width - margin.right - insideGraphMargin,
      ]);
      y_scale_orig = y_scale = create_scale(me.state.axis_y, [
        me.state.height - margin.bottom - insideGraphMargin,
        margin.top + insideGraphMargin,
      ]);
      const xTickFormatter = getTickFormatter(me.state.axis_x, x_scale);
      const yTickFormatter = getTickFormatter(me.state.axis_y, y_scale);
      const yTickCount = 1 + me.state.height / 40;
      const xTickCount = 1 + me.state.width / 80;
      const xTickValues = getTickValues(me.state.axis_x, x_scale, xTickCount);
      const yTickValues = getTickValues(me.state.axis_y, y_scale, yTickCount);
      zoom_brush = d3
        .brush()
        .extent([
          [margin.left, margin.top],
          [me.state.width - margin.right, me.state.height - margin.bottom],
        ])
        .on("end", brushended);

      yAxis = (g) =>
        g
          .attr("transform", `translate(${margin.left - 10},0)`)
          .call(
            d3
              .axisLeft(y_scale)
              .ticks(yTickCount)
              .tickValues(yTickValues as any)
              .tickFormat(yTickFormatter as any)
              .tickSizeInner(margin.left + margin.right - me.state.width),
          )
          .call((g) => g.select(".domain").remove())
          .call((g) => {
            const pd = me.props.params_def[me.state.axis_y];
            g.append("text")
              .attr("x", 13)
              .attr("y", 25)
              .attr("text-anchor", "start")
              .attr("font-weight", "bold")
              .attr("fill", "currentColor")
              .classed(style.axisLabelText, true)
              .classed("plotxy-label", true)
              .text(labelTextFromHtml(pd.label_html, pd.name))
              .append("title")
              .text(IS_MOBILE ? "Long-press for options" : "Right click for options");
            g.select(".plotxy-label")
              .on("contextmenu", (event) => {
                if (me.props.context_menu_ref && me.props.context_menu_ref.current) {
                  me.props.context_menu_ref.current.show(event.pageX, event.pageY, pd.name);
                  event.preventDefault();
                  event.stopPropagation();
                }
              })
              .on("touchstart", function (event) {
                if (!me.props.context_menu_ref || !me.props.context_menu_ref.current) return;
                const target = this as any;
                target.__longPressFired = false;
                const touch = (event as TouchEvent).touches[0];
                target.__longPressTimer = window.setTimeout(() => {
                  me.props.context_menu_ref.current.show(touch.pageX, touch.pageY, pd.name);
                  target.__longPressFired = true;
                  target.__longPressTimer = null;
                }, 500);
              })
              .on("touchend touchcancel touchmove", function (event) {
                const target = this as any;
                if (target.__longPressTimer) {
                  window.clearTimeout(target.__longPressTimer);
                  target.__longPressTimer = null;
                }
                if (target.__longPressFired) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              });
          })
          .attr("font-size", null);
      xAxis = (g) =>
        g
          .attr("transform", `translate(0,${me.state.height - margin.bottom})`)
          .call(
            d3
              .axisBottom(x_scale)
              .ticks(xTickCount)
              .tickValues(xTickValues as any)
              .tickFormat(xTickFormatter as any)
              .tickSizeInner(margin.bottom + margin.top - me.state.height),
          )
          // Make odd ticks below (to prevent overlap when very long labels)
          .call((g) =>
            g.selectAll(".tick").each(function (this: SVGGElement, d: string, i: number) {
              const line = this.children[0] as SVGLineElement;
              if (
                this.childElementCount === 2 &&
                (this.children[1] as SVGTextElement).textLength.baseVal.value &&
                line.nodeName === "line"
              ) {
                this.transform.baseVal.getItem(0).matrix.f += 20 * (i % 2);
                line.setAttribute("y2", `${parseFloat(line.getAttribute("y2")) - 20 * (i % 2)}`);
              }
            }),
          )
          .call((g) => {
            const pd = me.props.params_def[me.state.axis_x];
            const centerX = (margin.left + me.state.width - margin.right) / 2;
            g.append("text")
              .attr("x", centerX)
              .attr("y", 45)
              .attr("text-anchor", "middle")
              .attr("font-weight", "bold")
              .attr("fill", "currentColor")
              .classed(style.axisLabelText, true)
              .classed("plotxy-label", true)
              .text(labelTextFromHtml(pd.label_html, pd.name))
              .append("title")
              .text(IS_MOBILE ? "Long-press for options" : "Right click for options");
            g.select(".plotxy-label")
              .on("contextmenu", (event) => {
                if (me.props.context_menu_ref && me.props.context_menu_ref.current) {
                  me.props.context_menu_ref.current.show(event.pageX, event.pageY, pd.name);
                  event.preventDefault();
                  event.stopPropagation();
                }
              })
              .on("touchstart", function (event) {
                if (!me.props.context_menu_ref || !me.props.context_menu_ref.current) return;
                const target = this as any;
                target.__longPressFired = false;
                const touch = (event as TouchEvent).touches[0];
                target.__longPressTimer = window.setTimeout(() => {
                  me.props.context_menu_ref.current.show(touch.pageX, touch.pageY, pd.name);
                  target.__longPressFired = true;
                  target.__longPressTimer = null;
                }, 500);
              })
              .on("touchend touchcancel touchmove", function (event) {
                const target = this as any;
                if (target.__longPressTimer) {
                  window.clearTimeout(target.__longPressTimer);
                  target.__longPressTimer = null;
                }
                if (target.__longPressFired) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              });
          })
          .attr("font-size", null);
      div
        .selectAll("canvas")
        .attr("width", me.state.width - margin.left - margin.right)
        .attr("height", me.state.height - margin.top - margin.bottom);
      div.selectAll("svg").attr("width", me.state.width).attr("height", me.state.height);
      div.style("height", me.state.height + "px");
      div
        .selectAll("canvas")
        .style(
          "margin",
          margin.top + "px " + margin.right + "px " + margin.bottom + "px " + margin.left + "px",
        );

      redraw_axis();
    }
    function on_move() {
      const pos_top = $(me.root_ref.current).position().top;
      const pos_left = $(me.root_ref.current).position().left;
      div
        .selectAll("canvas")
        .style("top", pos_top + "px")
        .style("left", pos_left + "px");
      me.svg.style("top", pos_top + "px").style("left", pos_left + "px");
    }
    function brushended(event) {
      const s = event.selection;
      if (!s) {
        if (x_scale === x_scale_orig && y_scale === y_scale_orig) {
          return;
        }
        x_scale = x_scale_orig;
        y_scale = y_scale_orig;
      } else {
        if (x_scale.invert !== undefined) {
          const xrange = [x_scale.invert(s[0][0]), x_scale.invert(s[1][0])];
          x_scale = create_scale(me.state.axis_x, [margin.left, me.state.width - margin.right]);
          x_scale.domain(xrange);
        }
        if (y_scale.invert !== undefined) {
          const yrange = [y_scale.invert(s[1][1]), y_scale.invert(s[0][1])];
          y_scale = create_scale(me.state.axis_y, [me.state.height - margin.bottom, margin.top]);
          y_scale.domain(yrange);
        }
      }
      redraw_axis_and_rerender();
    }
    on_move();

    function hover(svg, _path) {
      const dot = me.svg.append("g").attr("display", "none");

      dot.append("circle").attr("r", 2.5);

      dot
        .append("text")
        .style("font", "10px sans-serif")
        .attr("text-anchor", "middle")
        .attr("y", -8);

      if ("ontouchstart" in document)
        svg
          .style("-webkit-tap-highlight-color", "transparent")
          .on("touchmove", moved)
          .on("touchstart", entered)
          .on("touchend", left);
      else svg.on("mousemove", moved).on("mouseenter", entered).on("mouseleave", left);

      function moved(event) {
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
        let closest = null;
        let closest_dist = null;
        $.each(currently_displayed, (_, dp) => {
          const dist = (dp["layerX"] - ex) ** 2 + (dp["layerY"] - ey) ** 2;
          if (closest_dist == null || dist < closest_dist) {
            closest_dist = dist;
            closest = dp;
          }
        });
        if (closest === null) {
          dot.attr("transform", `translate(${ex},${ey})`);
          dot.select("text").text("No point found?!");
          return;
        }
        me.setState({
          hover_uid: closest["dp"].uid,
        });
        dot.attr("transform", `translate(${closest["layerX"]},${closest["layerY"]})`);
        dot.select("text").text(me.props.render_row_text(closest["dp"]));
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

    me.svg.call(hover);

    function render_dp(dp, ctx, c) {
      if (c.lines_color) ctx.strokeStyle = c.lines_color;
      if (c.dots_color) ctx.fillStyle = c.dots_color;
      if (c.lines_width) ctx.lineWidth = c.lines_width;
      const pdx = me.props.params_def[me.state.axis_x];
      const pdy = me.props.params_def[me.state.axis_y];
      function is_err(value, scaled_value, def) {
        return (
          value === undefined ||
          value === null ||
          isNaN(scaled_value) ||
          (def.numeric && (value === "inf" || value === "-inf"))
        );
      }
      function render_point_position(dp) {
        let x = x_scale(dp[me.state.axis_x]);
        let y = y_scale(dp[me.state.axis_y]);
        x -= margin.left;
        y -= margin.top;

        const err = is_err(dp[me.state.axis_x], x, pdx) || is_err(dp[me.state.axis_y], y, pdy);
        if (err) {
          return null;
        }
        if (c.remember) {
          currently_displayed.push({
            layerX: x + margin.left,
            layerY: y + margin.top,
            dp: dp,
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
          console.log("DataPoint with id " + dp.from_uid + " not found (dp.from_uid)", dp);
        }
      }
      if (c.dots_thickness > 0) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, c.dots_thickness, 0, 2 * Math.PI, true);
        ctx.fill();
      }
    }

    function draw_selected_rows() {
      if (!me.isEnabled()) {
        return;
      }
      clear_canvas();
      const xp_config = me.props;
      const area = (me.state.height * me.state.width) / 400000;
      const lines_opacity =
        xp_config.lines_opacity !== null
          ? xp_config.lines_opacity
          : d3.min([(3 * area) / me.props.rows_selected.length ** 0.3, 1]);
      const dots_opacity =
        xp_config.dots_opacity !== null
          ? xp_config.dots_opacity
          : d3.min([(4 * area) / me.props.rows_selected.length ** 0.3, 1]);
      me.props.rows_selected.forEach((dp: Datapoint) => {
        render_dp(dp, graph_lines, {
          lines_color: me.props.get_color_for_row(dp, lines_opacity),
          lines_width: xp_config.lines_thickness,
          dots_color: me.props.get_color_for_row(dp, dots_opacity),
          dots_thickness: xp_config.dots_thickness,
          remember: true,
        });
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
      const highlighted = me.props.rows_highlighted;
      highlights.clearRect(0, 0, me.state.width, me.state.height);
      d3.select(me.canvas_highlighted_ref.current).style("opacity", "0");
      d3.select(me.canvas_lines_ref.current).style("opacity", "1.0");
      if (!highlighted.length) {
        return;
      }
      d3.select(me.canvas_highlighted_ref.current).style("opacity", "1.0");
      d3.select(me.canvas_lines_ref.current).style("opacity", "0.5");
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
      const lookupNextDp: (dp: Datapoint) => Datapoint[] = {
        [HIGHLIGHT_CHILDREN]: lookupChildren,
        [HIGHLIGHT_PARENT]: lookupParent,
      }[me.state.highlightType];

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
      allHighlighted.forEach((dp) => {
        const color = me.props.get_color_for_row(dp, 1.0).split(",");
        render_dp(dp, highlights, {
          lines_color: [color[0], color[1], color[2], 1.0 + ")"].join(","),
          lines_width: 4,
          dots_color: [color[0], color[1], color[2], 0.8 + ")"].join(","),
          dots_thickness: me.props.dots_highlighed_thickness,
        });
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
      clear_canvas: clear_canvas,
      update_axis: update_axis,
      recompute_scale: recompute_scale,
      draw_selected_rows: draw_selected_rows,
      draw_highlighted: draw_highlighted,
      on_resize: _.debounce(
        function (this: PlotXY) {
          if (this.isEnabled()) {
            recompute_scale();
            draw_selected_rows();
          }
        }.bind(this),
        150,
      ),
    };
  }
  onResize = _.debounce(
    function (height: number, width: number): void {
      if (this.state.height !== height || this.state.width !== width) {
        this.setState({ height: height, width: width });
      }
    }.bind(this),
    100,
  );
  disable(): void {
    this.setState({ axis_x: null, axis_y: null, height: this.state.initialHeight });
  }
  render() {
    if (!this.isEnabled()) {
      return [];
    }
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
            <canvas
              ref={this.canvas_lines_ref}
              className={style["plotxy-graph-lines"]}
              style={{ position: "absolute" }}
            ></canvas>
            <canvas
              ref={this.canvas_highlighted_ref}
              className={style["plotxy-graph-highlights"]}
              style={{ position: "absolute" }}
            ></canvas>
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
  componentWillUnmount() {
    if (this.plot) {
      this.plot.clear_canvas();
      this.plot.on_resize.cancel();
      this.svg.selectAll("*").remove();
    }
    if (this.props.context_menu_ref && this.props.context_menu_ref.current) {
      this.props.context_menu_ref.current.removeCallbacks(this);
    }
    this.drawSelectedThrottled.cancel();
    this.onResize.cancel();
    if (this.plotXYcontextMenuRef.current) {
      this.plotXYcontextMenuRef.current.removeCallbacks(this);
    }
  }
  isEnabled() {
    return this.state.axis_x !== null && this.state.axis_y !== null;
  }
  drawSelected = function (this: PlotXY) {
    if (this.plot) {
      this.plot.draw_selected_rows();
    }
  }.bind(this);
  drawSelectedThrottled = _.throttle(this.drawSelected, 100);
  componentDidUpdate(prevProps: PlotXYProps, prevState) {
    let anyAxisChanged = false;
    ["axis_x", "axis_y"].forEach(
      function (this: PlotXY, d: string) {
        if (prevState[d] !== this.state[d]) {
          this.props.persistentState.set(d, this.state[d]);
          anyAxisChanged = true;
        }
      }.bind(this),
    );
    if (this.state.highlightType !== prevState.highlightType) {
      this.props.persistentState.set("highlightType", this.state.highlightType);
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
    } else {
      if (anyAxisChanged) {
        this.plot.update_axis();
        this.props.sendMessage("height_changed", () => null);
      }
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
      let scaleRecomputed = false;
      const colorByChange =
        this.props.params_def[this.props.colorby] !== prevProps.params_def[prevProps.colorby];
      if (
        this.props.params_def[this.state.axis_x] !== prevProps.params_def[this.state.axis_x] ||
        this.props.params_def[this.state.axis_y] !== prevProps.params_def[this.state.axis_y]
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
