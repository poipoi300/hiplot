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
import { apply_filters, type Filter, FilterType } from "../filters";
import style from "../hiplot.module.css";
import { create_d3_scale, type ParamDef, scale_pixels_range } from "../infertypes";
import { IS_MOBILE } from "../lib/browsercompat";
import { getLogScaleTickValues } from "../lib/d3_scales";
import { ResizableH } from "../lib/resizable";
import type { HiPlotPluginData } from "../plugin";
import { type Datapoint, ParamType } from "../types";
import pstyle from "./parallel.module.css";

interface StringMapping<V> {
  [key: string]: V;
}

interface ParallelPlotState {
  height: number;
  width: number;
  order: Array<string>;
  hide: Set<string>;
  invert: Set<string>;
  dimensions: Array<string>;
  brush_count: number;

  dragging: { col: string; pos: number; origin: number; dragging: boolean };
}

interface PPlotInternal {
  redraw_axis: () => void;
  brush: () => void;
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

const TOP_MARGIN_PIXELS = 120;
const H_MARGIN_PIXELS = 20;
export class ParallelPlot extends React.Component<ParallelPlotData, ParallelPlotState> {
  on_resize: () => void = null;
  m = [
    TOP_MARGIN_PIXELS, // top
    H_MARGIN_PIXELS * 0.25, // right
    TOP_MARGIN_PIXELS * 0.125, // bottom
    H_MARGIN_PIXELS * 1.75, // left
  ]; // Margins
  // Available space minus margins
  w: number;
  h: number;

  pplot: PPlotInternal;

  dimensions_dom: d3.Selection<SVGGElement, string, SVGGElement, unknown> = null;
  render_speed = 10;
  animloop: d3.Timer = null;

  xscale: any;

  brush: any;

  // Rendering
  root_ref: React.RefObject<HTMLDivElement> = React.createRef();
  foreground_ref: React.RefObject<HTMLCanvasElement> = React.createRef();
  foreground: CanvasRenderingContext2D;
  highlighted_ref: React.RefObject<HTMLCanvasElement> = React.createRef();
  highlighted: CanvasRenderingContext2D;

  svg_ref: React.RefObject<SVGSVGElement> = React.createRef();
  svgg_ref: React.RefObject<SVGGElement> = React.createRef();

  div: any;

  // Dimensions, scaling and axis
  yscale: StringMapping<any> = {}; // d3.scale
  axis: d3.Axis<number>;
  d3brush = d3.brushY();

  private labelTextFromHtml(html: string, fallback: string): string {
    const tmp = document.createElement("div");
    tmp.innerHTML = html || "";
    const text = (tmp.textContent || tmp.innerText || "").trim();
    return text.length ? text : fallback;
  }

  private normalizeBrushSelection(sel: d3.BrushSelection): [number, number] | null {
    if (!sel) {
      return null;
    }
    if (Array.isArray(sel[0])) {
      const box = sel as [[number, number], [number, number]];
      return [box[0][1], box[1][1]];
    }
    return sel as [number, number];
  }

  private getBrushExtents() {
    const extents: { [key: string]: [number, number] | null } = {};
    if (!this.dimensions_dom) {
      return extents;
    }
    const normalizeBrushSelection = this.normalizeBrushSelection.bind(this);
    this.dimensions_dom.selectAll("." + pstyle.brush).each(function (
      this: SVGGElement,
      dim: string,
    ) {
      extents[dim] = normalizeBrushSelection(d3.brushSelection(this));
    });
    return extents;
  }

  toggleInvertAxis(d: string) {
    // save extent before inverting
    const extents = this.getBrushExtents();
    const currentExtent = extents[d];
    const extent = currentExtent ? [this.h - currentExtent[1], this.h - currentExtent[0]] : null;
    const div = d3.select(this.root_ref.current);

    const willBeInverted = !this.state.invert.has(d);

    if (!willBeInverted) {
      this.setState((prevState) => {
        const newInvert = new Set(prevState.invert);
        newInvert.delete(d);
        return {
          invert: newInvert,
        };
      });
      this.setScaleRange(d, willBeInverted);
      div
        .selectAll("." + style.label)
        .filter((p) => p === d)
        .style("text-decoration", null);
    } else {
      this.setState((prevState) => {
        const newInvert = new Set(prevState.invert);
        newInvert.add(d);
        return {
          invert: newInvert,
        };
      });
      this.setScaleRange(d, willBeInverted);
      div
        .selectAll("." + style.label)
        .filter((p) => p === d)
        .style("text-decoration", "underline");
    }
    return extent;
  }

  constructor(props: ParallelPlotData) {
    super(props);
    this.state = {
      height: props.persistentState.get(
        "height",
        props.window_state.height ? props.window_state.height : 600,
      ),
      width: 0, // Will be initiatialize to element width
      order: props.persistentState.get("order", props.order ? props.order : []),
      hide: new Set(props.persistentState.get("hide", props.hide ? props.hide : [])),
      invert: new Set(props.persistentState.get("invert", props.invert ? props.invert : [])),
      dimensions: [],
      brush_count: 0,
      dragging: null,
    };
  }
  static defaultProps = {
    categoricalMaximumValues: 200,
    data: {},
  };
  componentWillUnmount() {
    d3.select(this.svgg_ref.current).selectAll("*").remove();
    if (this.animloop) {
      this.animloop.stop();
    }
    if (this.props.context_menu_ref && this.props.context_menu_ref.current) {
      this.props.context_menu_ref.current.removeCallbacks(this);
    }
    this.onBrushChange.cancel();
    this.sendBrushExtents.cancel();
  }
  componentDidUpdate(prevProps: ParallelPlotData, prevState: ParallelPlotState) {
    if (prevState.height !== this.state.height || prevState.width !== this.state.width) {
      if (this.on_resize != null) {
        this.on_resize();
      }
    }
    if (prevState.invert !== this.state.invert) {
      this.props.persistentState.set("invert", Array.from(this.state.invert));
    }
    if (prevState.hide !== this.state.hide) {
      this.props.persistentState.set("hide", Array.from(this.state.hide));
      // Notify parent of hidden columns count change
      if (this.props.onHiddenColumnsChange) {
        this.props.onHiddenColumnsChange(this.getRestorableColumnsCount());
      }
    }
    if (prevState.order !== this.state.order) {
      this.props.persistentState.set("order", this.state.order);
    }
    if (prevState.dimensions !== this.state.dimensions && this.xscale !== undefined) {
      let g: any = d3.select(this.svgg_ref.current).selectAll(".dimension");
      this.xscale.domain(this.state.dimensions);
      this.dimensions_dom
        .filter(
          function (this: ParallelPlot, p) {
            return this.state.dimensions.indexOf(p) === -1;
          }.bind(this),
        )
        .remove();
      this.dimensions_dom = this.dimensions_dom.filter(
        function (this: ParallelPlot, p) {
          return this.state.dimensions.indexOf(p) !== -1;
        }.bind(this),
      );
      if (!this.state.dragging) {
        g = g.transition();
      }
      g.attr(
        "transform",
        function (this: ParallelPlot, p) {
          return "translate(" + this.position(p) + ")";
        }.bind(this),
      );

      this.update_ticks();
      this.updateAxisTitlesAnglesAndFontSize();
      // Notify parent of hidden columns count change (dimensions affects can_restore_axis)
      if (this.props.onHiddenColumnsChange) {
        this.props.onHiddenColumnsChange(this.getRestorableColumnsCount());
      }
    }
    // Highlight polylines
    if (prevProps.rows_highlighted !== this.props.rows_highlighted) {
      this.highlighted.clearRect(0, 0, this.w, this.h);
      if (this.props.rows_highlighted.length === 0) {
        d3.select(this.foreground_ref.current).style("opacity", null);
      } else {
        d3.select(this.foreground_ref.current).style("opacity", "0.25");
        this.props.rows_highlighted.forEach(
          function (this: ParallelPlot, dp: Datapoint) {
            this.path(dp, this.highlighted, this.props.get_color_for_row(dp, 1));
          }.bind(this),
        );
      }
    }
    // Recompute scales - when dimensions got removed, or scaling changed for one
    if (
      this.pplot &&
      (this.state.dimensions !== prevState.dimensions ||
        prevProps.params_def !== this.props.params_def)
    ) {
      const drop_scales = [];
      this.state.dimensions.forEach(
        function (this: ParallelPlot, d: string) {
          const new_scale = this.createScale(d);
          if (new_scale === null) {
            drop_scales.push(d);
            return;
          }
          this.yscale[d] = new_scale;
        }.bind(this),
      );
      drop_scales.forEach(
        function (this: ParallelPlot, d: string) {
          this.remove_axis(d);
        }.bind(this),
      );
    }
    // Dimension added - redraw missing axis
    const oldDimsSet = new Set(prevState.dimensions);
    if (this.pplot && ![...this.state.dimensions].every((value) => oldDimsSet.has(value))) {
      this.pplot.redraw_axis();
    }
    // Rescale to new dataset domain
    if (this.pplot && prevProps.params_def !== this.props.params_def) {
      this.brush_clear_all();
      this.update_ticks();

      if (this.animloop) {
        this.animloop.stop();
      }
    }
    // When we need to redraw lines
    if (
      prevProps.rows_selected !== this.props.rows_selected ||
      prevProps.colorby !== this.props.colorby ||
      prevState.height !== this.state.height ||
      prevState.width !== this.state.width
    ) {
      this.setState((prevState) => ({ brush_count: prevState.brush_count + 1 }));
    } else if (prevState.brush_count !== this.state.brush_count) {
      this.paths(this.props.rows_selected, this.foreground, this.state.brush_count);
    }
    this.props.window_state.height = this.state.height;
  }
  onBrushChange = _.throttle(
    function (this: ParallelPlot): void {
      this.sendBrushExtents();
      this.pplot.brush();
    }.bind(this),
    75,
  );
  onResize(height: number, width: number): void {
    if (this.state.height !== height || this.state.width !== width) {
      this.setState({ height: height, width: width });
    }
  }

  get_axis = function (d: string) {
    const pd = this.props.params_def[d];
    const fmt = pd.ticks_format;
    const tickCount = 1 + this.state.height / 50;
    const axis = this.axis.scale(this.yscale[d]).ticks(tickCount, fmt);
    if (pd.type === ParamType.NUMERICLOG) {
      const scale = this.yscale[d];
      const domain = scale.domain();
      const tickValues = getLogScaleTickValues(domain, tickCount);
      if (tickValues) {
        // Preserve the NaN tick if the scale includes outlier handling
        if (scale.__scale_orig) {
          tickValues.push(NaN);
        }
        axis.tickValues(tickValues);
      } else {
        // Clear any tickValues left from a previous column on the shared axis
        axis.tickValues(null);
      }
    } else {
      // Clear any tickValues left from a previous column on the shared axis
      axis.tickValues(null);
    }
    return axis;
  }.bind(this);

  render() {
    return (
      <ResizableH initialHeight={this.state.height} onResize={this.onResize.bind(this)}>
        <div
          ref={this.root_ref}
          className={`${pstyle["parallel-plot-chart"]} pplot-root`}
          style={{ height: this.state.height }}
        >
          <canvas ref={this.foreground_ref} className={style["background-canvas"]}></canvas>
          <canvas ref={this.highlighted_ref} className={style["highlight-canvas"]}></canvas>
          <svg
            ref={this.svg_ref}
            width={this.state.width}
            height={this.state.height}
            role="img"
            aria-label="Parallel coordinates axes"
          >
            <g ref={this.svgg_ref} transform={`translate(${this.m[3]}, ${this.m[0]})`}></g>
          </svg>
        </div>
      </ResizableH>
    );
  }
  sendBrushExtents = _.debounce(
    function (this: ParallelPlot): void {
      this.props.sendMessage(
        "brush_extents",
        function (this: ParallelPlot) {
          const yscales = this.yscale;
          const colToScale = {};
          this.dimensions_dom.selectAll("." + pstyle.brush).each(function (
            this: SVGGElement,
            dim: string,
          ) {
            const sel: d3.BrushSelection = d3.brushSelection(this);
            if (sel === null) {
              return;
            }
            colToScale[dim] = scale_pixels_range(yscales[dim], sel as [number, number]);
          });
          return colToScale;
        }.bind(this),
      );
    }.bind(this),
    400,
  );
  forceHideColumn = function (pd: ParamDef) {
    return (
      pd === undefined ||
      pd.distinct_values.length <= 1 ||
      (pd.type === ParamType.CATEGORICAL &&
        pd.distinct_values.length > this.props.categoricalMaximumValues)
    );
  }.bind(this);
  componentDidMount() {
    const dimensions = Object.keys(this.props.params_def)
      .filter(
        function (this: ParallelPlot, k: string) {
          if (this.forceHideColumn(this.props.params_def_unfiltered[k]) || this.state.hide.has(k)) {
            return false;
          }
          this.yscale[k] = this.createScale(k);
          return true;
        }.bind(this),
      )
      .reverse()
      .sort(
        function (this: ParallelPlot, a: string, b: string) {
          const pda = this.state.order.findIndex((e) => e === b);
          const pdb = this.state.order.findIndex((e) => e === a);
          return (
            (pdb === -1 ? this.state.order.length : pdb) -
            (pda === -1 ? this.state.order.length : pda)
          );
        }.bind(this),
      );
    this.setState(
      {
        width: this.state.width === 0 ? this.root_ref.current.offsetWidth : this.state.width,
        dimensions: dimensions,
        order: Array.from(dimensions),
      },
      this.initParallelPlot.bind(this),
    );

    if (this.props.context_menu_ref && this.props.context_menu_ref.current) {
      this.props.context_menu_ref.current.addCallback(this.columnContextMenu.bind(this), this);
    }
    // Notify parent of initial hidden columns count
    if (this.props.onHiddenColumnsChange) {
      const count = this.getRestorableColumnsCount();
      if (count > 0) {
        this.props.onHiddenColumnsChange(count);
      }
    }
  }
  columnContextMenu(column: string, cm: HTMLDivElement) {
    if (!this.can_restore_axis(column)) {
      return;
    }
    const restore_btn = $(`<a class="dropdown-item" href="#">Restore in Parallel Plot</a>`);
    restore_btn.on(
      "click",
      function (this: ParallelPlot, event) {
        this.restore_axis(column);
        event.preventDefault();
      }.bind(this),
    );
    $(cm).append(restore_btn);
  }

  position = function (this: ParallelPlot, d: string): number {
    if (this.state.dragging && d === this.state.dragging.col) {
      return this.state.dragging.pos;
    }
    return this.xscale(d);
  }.bind(this);

  initParallelPlot(this: ParallelPlot) {
    const me = this;

    this.div = d3.select(me.root_ref.current);
    const div = this.div;
    const svg = d3.select(me.svg_ref.current);

    // Foreground canvas for primary view
    me.foreground = this.foreground_ref.current.getContext("2d");
    me.foreground.globalCompositeOperation = "destination-over";

    // Highlight canvas for temporary interactions
    me.highlighted = this.highlighted_ref.current.getContext("2d");

    // SVG for ticks, labels, and interactions

    // Load the data and visualization
    function redraw_axis() {
      // Extract the list of numerical dimensions and create a scale for each.
      me.xscale.domain(me.state.dimensions);

      // Add a group element for each dimension.
      function create_drag_beh() {
        return d3
          .drag()
          .container(function () {
            return this.parentElement.parentElement.parentElement;
          })
          .on("start", (event, d: string) => {
            me.setState({
              dragging: {
                col: d,
                pos: me.xscale(d),
                origin: me.xscale(d),
                dragging: false,
              },
            });
            d3.select(me.foreground_ref.current).style("opacity", "0.35");
          })
          .on("drag", function (event, d: string) {
            const eventdx = event.dx;
            const brushEl = d3.select(this).select("." + pstyle.brush);
            me.setState(
              (prevState, _) => {
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
            me.dimensions_dom.attr("transform", (d) => "translate(" + me.position(d) + ")");
          })
          .on("end", function (event, d: string) {
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
            } else {
              // remove axis if dragged all the way left
              if (me.state.dragging.pos < 12 || me.state.dragging.pos > me.w - 12) {
                me.remove_axis(d);
              } else {
                me.setState({ order: Array.from(me.state.dimensions), dragging: null }, () => {
                  // reorder axes
                  const parentG = d3.select(this.parentElement.parentElement);
                  parentG.transition().attr("transform", "translate(" + me.xscale(d) + ")");
                  const extents = brush_extends();
                  const extent = extents[d];
                  me.update_ticks(d, extent);
                });
              }
            }

            // rerender
            d3.select(me.foreground_ref.current).style("opacity", null);
            me.setState({ dragging: null });
          });
      }
      if (me.dimensions_dom) {
        me.dimensions_dom.remove();
      }
      me.dimensions_dom = d3
        .select(me.svgg_ref.current)
        .selectAll<SVGGElement, string>(".dimension")
        // reverse the order so that the tooltips appear on top of the axis ticks
        .data(me.state.dimensions.slice().reverse())
        .enter()
        .append<SVGGElement>("svg:g")
        .attr("class", "dimension")
        .attr("transform", (d) => "translate(" + me.xscale(d) + ")");

      // Add an axis and title.
      me.dimensions_dom
        .append("svg:g")
        .attr("class", pstyle.axis)
        .attr("transform", "translate(0,0)")
        .each(function (d) {
          console.assert(me.yscale[d], d, me.yscale, this);
          d3.select(this).call(me.get_axis(d));
        })
        .append("text")
        .text((dim) => {
          const pd = me.props.params_def[dim];
          return me.labelTextFromHtml(pd.label_html, pd.name);
        })
        .attr("text-anchor", "left")
        .classed("pplot-label", true)
        .classed("label-name", true)
        .classed(style.label, true)
        .classed(style.axisLabelText, true)
        .classed(pstyle.pplotLabel, true)
        .each(function (_dim) {
          d3.select(this)
            .append("title")
            .text(IS_MOBILE ? "Long-press for options" : "Right click for options");
        })
        .on("contextmenu", (event, dim: string) => {
          if (me.props.context_menu_ref && me.props.context_menu_ref.current) {
            me.props.context_menu_ref.current.show(event.pageX, event.pageY, dim);
            event.preventDefault();
            event.stopPropagation();
          }
        })
        .on("touchstart", function (event, dim: string) {
          const target = this as SVGTextElement;
          if (!me.props.context_menu_ref || !me.props.context_menu_ref.current) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          (target as any).__longPressFired = false;
          const touch = (event as TouchEvent).touches[0];
          const timer = window.setTimeout(() => {
            me.props.context_menu_ref.current.show(touch.pageX, touch.pageY, dim);
            (target as any).__longPressFired = true;
            (target as any).__longPressTimer = null;
          }, 500);
          (target as any).__longPressTimer = timer;
        })
        .on("touchend touchcancel touchmove", function (event, dim: string) {
          const target = this as SVGTextElement;
          const timer = (target as any).__longPressTimer;
          if (timer) {
            window.clearTimeout(timer);
            (target as any).__longPressTimer = null;
          }
          if ((target as any).__longPressFired) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.type !== "touchend") {
            return;
          }
          const isDragging = me.state.dragging && me.state.dragging.dragging;
          if (isDragging) {
            return;
          }
          if (me.props.context_menu_ref && me.props.context_menu_ref.current) {
            const touch = (event as TouchEvent).changedTouches[0];
            me.props.context_menu_ref.current.show(touch.pageX, touch.pageY, dim);
            event.preventDefault();
            event.stopPropagation();
          }
        });
      me.updateAxisTitlesAnglesAndFontSize();
      me.dimensions_dom.selectAll(".pplot-label").call(create_drag_beh());

      // Add and store a brush for each axis.
      me.dimensions_dom
        .append("svg:g")
        .classed(pstyle.brush, true)
        .classed("pplot-brush", true)
        .each(function (_d) {
          d3.select(this).call(me.d3brush);
        })
        .selectAll("rect")
        .style("visibility", null)
        .append("title")
        .text("Drag up or down to brush along this axis");

      me.dimensions_dom.selectAll(".extent").append("title").text("Drag or resize this filter");
    }

    function brush_extends() {
      return me.getBrushExtents();
    }

    function brush() {
      /**
       * Called whenever a brush happens. Recomputes which points are selected.
       */
      if (me.props.context_menu_ref !== undefined) {
        me.props.context_menu_ref.current.hide();
      }
      const extents: { [key: string]: [number, number] | null } = brush_extends();
      const actives = me.state.dimensions.filter(
        (p) => extents[p] !== null && extents[p] !== undefined,
      );

      // hack to hide ticks beyond extent
      me.dimensions_dom.each(function (dimension) {
        if (_.include(actives, dimension)) {
          const scale = me.yscale[dimension];
          const extent = extents[dimension];
          d3.select(this)
            .selectAll("text")
            .classed(pstyle.tickSelected, true)
            .style("display", function () {
              if (d3.select(this).classed(style.label)) {
                return null;
              }
              const value = d3.select(this).data();
              return extent[0] <= scale(value) && scale(value) <= extent[1] ? null : "none";
            });
        } else {
          d3.select(this)
            .selectAll("text")
            .classed(pstyle.tickSelected, false)
            .style("display", null);
        }
        d3.select(this)
          .selectAll("." + style.label)
          .style("display", null);
      });

      // bold dimensions with label
      div.selectAll("." + style.label).style("font-weight", (dimension) => {
        if (_.include(actives, dimension)) return "bold";
        return null;
      });

      // Get lines within extents
      const filters: Array<Filter> = actives.map((dimension) => {
        const scale = me.yscale[dimension];
        const extent = extents[dimension] as [number, number];
        const range = scale_pixels_range(scale, extent);
        if (range.type === ParamType.CATEGORICAL && !range.values) {
          // Select nothing
          return {
            type: FilterType.Not,
            data: {
              type: FilterType.All,
              data: [],
            },
          };
        }
        let min: string | number;
        let max: string | number;
        if (range.type === ParamType.CATEGORICAL) {
          if (range.values.length === 0) {
            return {
              type: FilterType.None,
              data: {},
            };
          }
          min = range.values[0];
          max = range.values[range.values.length - 1];
          console.assert(typeof min === typeof max, min, max);
        } else {
          min = Math.min(...range.range);
          max = Math.max(...range.range);
        }
        return {
          type: FilterType.Range,
          data: {
            col: dimension,
            type: range.type,
            min: min,
            max: max,
            include_infnans: range.include_infnans,
          },
        };
      });
      const selected = apply_filters(me.props.rows_filtered, filters);

      if (me.props.asserts) {
        // Check that pixel-based selected rows
        // match filters-based selected rows
        // But relax the verification a bit - math errors can happen
        // and we only require a 1 pixel precision
        const selected_pixels_minset = [];
        const selected_pixels_maxset = [];
        me.props.rows_filtered.forEach((d) => {
          if (
            actives.every((dimension) => {
              const scale = me.yscale[dimension];
              const extent = extents[dimension] as [number, number];
              const value = d[dimension];
              return extent[0] + 1 <= scale(value) && scale(value) <= extent[1] - 1;
            })
          ) {
            selected_pixels_minset.push(d);
          }
          if (
            actives.every((dimension) => {
              const scale = me.yscale[dimension];
              const extent = extents[dimension] as [number, number];
              const value = d[dimension];
              return extent[0] - 1 <= scale(value) && scale(value) <= extent[1] + 1;
            })
          ) {
            selected_pixels_maxset.push(d);
          }
        });
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
          console.error("filters", filters, JSON.stringify(filters));
          if (missed.length) {
            console.error("first missed", JSON.stringify(missed[0]));
          }
          if (overselected.length) {
            console.error("first falsely selected", JSON.stringify(overselected[0]));
          }
        }
      }
      me.props.setSelected(selected, {
        type: FilterType.All,
        data: filters,
      });
    }

    // scale to window size
    this.on_resize = _.debounce(function () {
      me.compute_dimensions();

      div
        .selectAll(".dimension")
        .attr("transform", (d: string) => "translate(" + me.xscale(d) + ")");
      // update brush placement
      svg.selectAll("." + pstyle.brush).each(function (_d) {
        d3.select(this).call(me.d3brush);
      });

      // update axis placement
      div.selectAll("." + pstyle.axis).each(function (d: string) {
        d3.select(this).call(me.get_axis(d));
      });
      me.updateAxisTitlesAnglesAndFontSize();

      // render data
      this.setState((prevState) => ({ brush_count: prevState.brush_count + 1 }));
      this.props.sendMessage("height_changed", () => null);
    }, 100);

    me.compute_dimensions();
    redraw_axis();

    // Render full foreground
    brush();
    me.sendBrushExtents();

    // Trigger initial brush
    me.setState((prevState) => ({ brush_count: prevState.brush_count + 1 }));

    me.pplot = {
      redraw_axis: redraw_axis,
      brush: brush,
    };
  }

  setScaleRange(k: string, inverted: boolean = this.state.invert.has(k)) {
    let range = [this.h, 0];
    if (inverted) {
      range = [0, this.h];
    }
    this.yscale[k].range(range);
  }

  createScale(k: string) {
    const pd = this.props.params_def[k];
    if (pd === undefined) {
      return null;
    }
    let range = [this.h, 0];
    if (this.state.invert.has(k)) {
      range = [0, this.h];
    }
    const scale = create_d3_scale(pd);
    scale.range(range);
    scale.parallel_plot_axis = k;
    return scale;
  }

  updateAxisTitlesAnglesAndFontSize() {
    const FONT_SIZE = 12;
    this.dimensions_dom.selectAll(".pplot-label").each(function (this: SVGTextElement) {
      this.style.fontSize = FONT_SIZE + "px";
      this.style.writingMode = "";
      this.style.textOrientation = "";
      this.setAttribute("x", "10");
      this.setAttribute("y", "0");
      this.setAttribute("text-anchor", "start");
      this.setAttribute("transform", "rotate(-90)");
    });
  }

  compute_dimensions() {
    this.w = this.state.width - this.m[1] - this.m[3];
    this.h = this.state.height - this.m[0] - this.m[2];
    //@ts-expect-error
    this.axis = d3.axisLeft(d3.scaleLinear() /* placeholder */);
    this.d3brush
      .extent([
        [-23, 0],
        [15, this.h],
      ])
      .on("brush", this.onBrushChange)
      .on("end", this.onBrushChange);
    // Scale chart and canvas height
    this.div.style("height", this.state.height + "px");

    this.div
      .selectAll("canvas")
      .attr("width", this.w)
      .attr("height", this.h)
      .style("padding", this.m.join("px ") + "px");
    this.xscale = d3
      .scalePoint()
      .range([40, this.w - 40])
      .domain(this.state.dimensions);
    this.state.dimensions.forEach((d: string) => {
      this.setScaleRange(d);
    });
    this.highlighted.lineWidth = 4;
  }

  // transition ticks for reordering, rescaling and inverting
  update_ticks = function (d?: string, extent?) {
    const div = d3.select(this.root_ref.current);
    // update brushes
    if (d) {
      const brush_el = d3
        .select(this.svg_ref.current)
        .selectAll("." + pstyle.brush)
        .filter((key) => key === d);
      this.d3brush.move(brush_el, extent);
    } else {
      // all ticks
      d3.select(this.svg_ref.current)
        .selectAll("." + pstyle.brush)
        .each((d, i, nodes) => {
          d3.select(nodes[i]).call(this.d3brush);
        });
    }

    // update axes
    div.selectAll("." + pstyle.axis).each((d: string, i, nodes) => {
      const node = nodes[i];
      // transition axis numbers
      d3.select(node).transition().duration(720).call(this.get_axis(d));

      d3.select(node).selectAll(".tick text").style("font-weight", null).style("font-size", null);
    });
    this.setState((prevState) => ({ brush_count: prevState.brush_count + 1 }));
  }.bind(this);

  // render a set of polylines on a canvas
  paths = function (selected: Array<Datapoint>, ctx: CanvasRenderingContext2D, count: number) {
    let n = selected.length,
      i = 0,
      opacity = d3.min([2 / n ** 0.3, 1]),
      timer = new Date().getTime();

    const shuffled_data: Array<Datapoint> = _.shuffle(selected);

    ctx.clearRect(0, 0, this.w + 1, this.h + 1);

    // Adjusts rendering speed
    const optimize = (timer) => {
      const delta = new Date().getTime() - timer;
      this.render_speed = Math.max(Math.ceil((this.render_speed * 30) / delta), 8);
      this.render_speed = Math.min(this.render_speed, 300);
      return new Date().getTime();
    };

    // render a batch of polylines
    const render_range = (selection: Array<Datapoint>, i: number, max: number, opacity: number) => {
      const s = selection.slice(i, max);
      s.forEach((d) => {
        this.path(d, ctx, this.props.get_color_for_row(d, opacity));
      });
    };

    // render all lines until finished or a new brush event
    const animloop = () => {
      if (i >= n || count < this.state.brush_count) return true;
      const max = d3.min([i + this.render_speed, n]);
      render_range(shuffled_data, i, max, opacity);
      i = max;
      timer = optimize(timer); // adjusts render_speed
    };
    if (this.animloop) {
      this.animloop.stop();
    }
    if (n > 0) {
      this.animloop = d3.timer(animloop);
    }
  }.bind(this);

  brush_clear_all(): void {
    // Reset brushes - but only trigger call to "brush" once
    this.d3brush.on("brush", null).on("end", null);
    this.d3brush.move(this.dimensions_dom.selectAll("." + pstyle.brush), null);
    this.d3brush.on("brush", this.onBrushChange).on("end", this.onBrushChange);
    this.onBrushChange();
  }

  remove_axis(d: string): void {
    const pd = this.props.params_def[d];
    if (pd !== undefined) {
      this.setState((prevState, _props) => {
        const newHide = new Set(prevState.hide);
        newHide.add(d);
        return {
          hide: newHide,
        };
      });
    }
    this.setState((ps, __) => ({
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
  path = function (
    this: ParallelPlot,
    d: Datapoint,
    ctx: CanvasRenderingContext2D,
    color?: string,
  ) {
    if (color) ctx.strokeStyle = color;
    let has_started = false;
    let x0: number, y0: number;
    this.state.dimensions.map(
      function (this: ParallelPlot, p: string) {
        let err = d[p] === undefined;
        if (!err && (d[p] === "inf" || d[p] === "-inf") && this.props.params_def[p].numeric) {
          err = true;
        }
        const x = this.xscale(p),
          y = this.yscale[p](d[p]);
        if (isNaN(y)) {
          err = true;
        }
        if (err) {
          // Skip this one
          if (has_started) {
            ctx.lineTo(x0 + 15, y0); // right edge
            ctx.stroke();
          }
          has_started = false;
          return;
        }
        if (!has_started) {
          x0 = x - 15;
          y0 = y;
          ctx.moveTo(x0, y0);
          ctx.beginPath();
          has_started = true;
        }
        const cp1x = x - 0.88 * (x - x0);
        const cp1y = y0;
        const cp2x = x - 0.12 * (x - x0);
        const cp2y = y;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
        x0 = x;
        y0 = y;
      }.bind(this),
    );
    if (has_started) {
      ctx.lineTo(x0 + 15, y0); // right edge
      ctx.stroke();
    }
  }.bind(this);
}
