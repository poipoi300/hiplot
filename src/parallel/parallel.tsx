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
import {
  create_d3_scale,
  type ParamDef,
  type ParamScale,
  type ScaleDomainRange,
  scale_pixels_range,
} from "../infertypes";
import { IS_MOBILE } from "../lib/browsercompat";
import { getLogScaleTickValues } from "../lib/d3_scales";
import { labelTextFromHtml } from "../lib/escape";
import { mounted } from "../lib/refs";
import { ResizableH } from "../lib/resizable";
import { isNumber, isStringArray, readState } from "../lib/savedstate";
import type { HiPlotPluginData } from "../plugin";
import { type Datapoint, ParamType } from "../types";
import pstyle from "./parallel.module.css";

interface ParallelPlotState {
  height: number;
  width: number;
  order: Array<string>;
  hide: Set<string>;
  invert: Set<string>;
  dimensions: Array<string>;
  brush_count: number;

  dragging: { col: string; pos: number; origin: number; dragging: boolean } | null;
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

/** A tick value on a column axis: a number, or a category. */
type AxisValue = number | string;
type BrushExtents = { [dimension: string]: [number, number] | null };
/** An axis title being long-pressed on a touch screen. */
interface LongPress {
  timer: number | null;
  fired: boolean;
}

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
  /** Filtered rows in a random order fixed per dataset (see `drawOrder`). */
  private shuffled: { from: Datapoint[]; rows: Datapoint[] } | null = null;
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
      .selectAll<SVGTextElement, string>(`.${style.label}`)
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
      brush_count: 0,
      dragging: null,
    };
  }
  static defaultProps = {
    categoricalMaximumValues: 200,
  };
  componentWillUnmount() {
    d3.select(this.svgg_ref.current).selectAll("*").remove();
    this.cancelDrawing();
    this.props.context_menu_ref?.current?.removeCallbacks(this);
    this.onBrushChange.cancel();
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
        d3.select(this.foreground_ref.current).style("opacity", "0.25");
        this.props.rows_highlighted.forEach((dp: Datapoint) => {
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
    // When we need to redraw lines
    if (
      prevProps.rows_selected !== this.props.rows_selected ||
      prevProps.colorby !== this.props.colorby ||
      prevState.height !== this.state.height ||
      prevState.width !== this.state.width
    ) {
      this.setState((prevState) => ({ brush_count: prevState.brush_count + 1 }));
    } else if (prevState.brush_count !== this.state.brush_count && this.foreground !== null) {
      this.paths(this.props.rows_selected, this.foreground, this.state.brush_count);
    }
    this.props.window_state.height = this.state.height;
  }
  onBrushChange = _.throttle((): void => {
    this.sendBrushExtents();
    this.pplot?.brush();
  }, 75);
  onResize = (height: number, width: number): void => {
    if (this.state.height !== height || this.state.width !== width) {
      this.setState({ height: height, width: width });
    }
  };

  get_axis(d: string): d3.Axis<AxisValue> {
    const pd = this.props.params_def[d];
    const scale = this.yscale[d];
    const tickCount = 1 + this.state.height / 50;
    const axis = d3.axisLeft<AxisValue>(scale).ticks(tickCount, pd.ticks_format);
    if (pd.type !== ParamType.NUMERICLOG || scale.kind !== "continuous") {
      return axis;
    }
    const tickValues = getLogScaleTickValues(scale.domain(), tickCount);
    if (tickValues === null) {
      return axis;
    }
    // Keep the NaN tick of the inf/NaN band
    return axis.tickValues(scale.hasOutlierBand ? [...tickValues, NaN] : tickValues);
  }

  render() {
    return (
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
          >
            <g ref={this.svgg_ref} transform={`translate(${this.m[3]}, ${this.m[0]})`}></g>
          </svg>
        </div>
      </ResizableH>
    );
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

    // Foreground canvas for primary view
    const foreground = mounted(this.foreground_ref).getContext("2d");
    // Highlight canvas for temporary interactions
    const highlighted = mounted(this.highlighted_ref).getContext("2d");
    if (foreground === null || highlighted === null) {
      throw new Error("Canvas 2D is not available");
    }
    foreground.globalCompositeOperation = "destination-over";
    me.foreground = foreground;
    me.highlighted = highlighted;

    // Load the data and visualization
    function redraw_axis(): void {
      // Extract the list of numerical dimensions and create a scale for each.
      me.xscale.domain(me.state.dimensions);

      // Add a group element for each dimension.
      function create_drag_beh(): d3.DragBehavior<SVGTextElement, string, unknown> {
        return d3
          .drag<SVGTextElement, string>()
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
          .on("drag", function (this: SVGTextElement, event: { dx: number }, d: string) {
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
          .on("end", function (this: SVGTextElement, _event, d: string) {
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
        .attr("text-anchor", "left")
        .classed("pplot-label", true)
        .classed("label-name", true)
        .classed(style.label, true)
        .classed(style.axisLabelText, true)
        .classed(pstyle.pplotLabel, true)
        .each(function (this: SVGTextElement) {
          d3.select(this)
            .append("title")
            .text(IS_MOBILE ? "Long-press for options" : "Right click for options");
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
      dimensions_dom.selectAll<SVGTextElement, string>(".pplot-label").call(create_drag_beh());

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

    function brush(): void {
      /**
       * Called whenever a brush happens. Recomputes which points are selected.
       */
      me.props.context_menu_ref?.current?.hide();
      const extents = me.getBrushExtents();
      const actives = me.state.dimensions.filter(
        (p) => extents[p] !== null && extents[p] !== undefined,
      );

      // hack to hide ticks beyond extent
      me.dimensions_dom?.each(function (this: SVGGElement, dimension) {
        const extent = extents[dimension];
        const texts = d3.select(this).selectAll<SVGTextElement, AxisValue>("text");
        if (extent !== null && extent !== undefined && _.include(actives, dimension)) {
          const scale = me.yscale[dimension];
          texts
            .classed(pstyle.tickSelected, true)
            .style("display", function (this: SVGTextElement) {
              if (d3.select(this).classed(style.label)) {
                return null;
              }
              const position = scale(d3.select<SVGTextElement, AxisValue>(this).datum());
              return extent[0] <= position && position <= extent[1] ? null : "none";
            });
        } else {
          texts.classed(pstyle.tickSelected, false).style("display", null);
        }
        d3.select(this).selectAll(`.${style.label}`).style("display", null);
      });

      // bold dimensions with label
      div
        .selectAll<SVGTextElement, string>(`.${style.label}`)
        .style("font-weight", (dimension) => (_.include(actives, dimension) ? "bold" : null));

      // Get lines within extents
      const filters: Array<Filter> = actives.map((dimension): Filter => {
        const extent = extents[dimension];
        if (extent === null || extent === undefined) {
          throw new Error(`Dimension ${dimension} is not brushed`);
        }
        const range = scale_pixels_range(me.yscale[dimension], extent);
        if (range.type === ParamType.CATEGORICAL) {
          if (range.values.length === 0) {
            return { type: FilterType.None, data: {} };
          }
          return {
            type: FilterType.Range,
            data: {
              col: dimension,
              type: range.type,
              min: range.values[0],
              max: range.values[range.values.length - 1],
            },
          };
        }
        return {
          type: FilterType.Range,
          data: {
            col: dimension,
            type: range.type,
            min: Math.min(...range.range),
            max: Math.max(...range.range),
            include_infnans: range.include_infnans,
          },
        };
      });
      const selected = apply_filters(me.props.rows_filtered, filters);

      if (me.props.asserts) {
        me.assertPixelSelectionMatches(actives, extents, filters, selected);
      }
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

      // render data
      this.setState((prevState) => ({ brush_count: prevState.brush_count + 1 }));
      this.props.sendMessage("height_changed", () => null);
    }, 100);

    me.compute_dimensions();
    redraw_axis();

    me.pplot = {
      redraw_axis: redraw_axis,
      brush: brush,
    };

    // Render full foreground
    brush();
    me.sendBrushExtents();

    // Trigger initial brush
    me.setState((prevState) => ({ brush_count: prevState.brush_count + 1 }));
  }

  /**
   * Debug check (enabled by the `asserts` prop): rows selected by the filters must
   * match the rows whose pixels fall inside the brushes, within one pixel.
   */
  private assertPixelSelectionMatches(
    actives: string[],
    extents: BrushExtents,
    filters: Filter[],
    selected: Datapoint[],
  ): void {
    const insideBrushes = (d: Datapoint, tolerance: number): boolean =>
      actives.every((dimension) => {
        const extent = extents[dimension];
        if (extent === null || extent === undefined) {
          return false;
        }
        const position = this.yscale[dimension](d[dimension]);
        return extent[0] + tolerance <= position && position <= extent[1] - tolerance;
      });
    const selected_pixels_minset = this.props.rows_filtered.filter((d) => insideBrushes(d, 1));
    const selected_pixels_maxset = this.props.rows_filtered.filter((d) => insideBrushes(d, -1));
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

  updateAxisTitlesAnglesAndFontSize() {
    const FONT_SIZE = 12;
    this.dimensions_dom?.selectAll<SVGTextElement, string>(".pplot-label").each(function (
      this: SVGTextElement,
    ) {
      this.style.fontSize = `${FONT_SIZE}px`;
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
    this.d3brush
      .extent([
        [-23, 0],
        [15, this.h],
      ])
      .on("brush", this.onBrushChange)
      .on("end", this.onBrushChange);
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
    this.highlightContext().lineWidth = 4;
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
    this.setState((prevState) => ({ brush_count: prevState.brush_count + 1 }));
  }

  /** The filtered rows, shuffled once per dataset rather than on every redraw. */
  drawOrder(): Datapoint[] {
    const rows = this.props.rows_filtered;
    if (this.shuffled === null || this.shuffled.from !== rows) {
      this.shuffled = { from: rows, rows: _.shuffle(rows) };
    }
    return this.shuffled.rows;
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
   */
  paths(selected: Array<Datapoint>, ctx: CanvasRenderingContext2D, count: number): void {
    const opacity = Math.min(2 / selected.length ** 0.3, 1);
    const order = this.drawOrder();
    const selectedRows = selected === this.props.rows_filtered ? null : new Set(selected);
    const rows = selectedRows === null ? order : order.filter((row) => selectedRows.has(row));
    const n = rows.length;
    const binning = this.props.color_binning;
    const colorby = this.props.colorby;
    let i = 0;
    let previousFrame: number | null = null;
    let drawnLastFrame = 0;

    this.cancelDrawing();
    ctx.clearRect(0, 0, this.w + 1, this.h + 1);

    const drawFrame = (now: number): void => {
      this.drawingFrame = null;
      if (count < this.state.brush_count) {
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
      const rowsByBin = new Map<number, Datapoint[]>();
      for (; i < end; ++i) {
        const row = rows[i];
        const bin = binning.binOf(row[colorby]);
        const binRows = rowsByBin.get(bin);
        if (binRows === undefined) {
          rowsByBin.set(bin, [row]);
        } else {
          binRows.push(row);
        }
      }
      rowsByBin.forEach((binRows, bin) => {
        ctx.strokeStyle = binning.css(bin, opacity);
        ctx.beginPath();
        binRows.forEach((row) => {
          this.tracePath(row, ctx);
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
    this.d3brush.on("brush", this.onBrushChange).on("end", this.onBrushChange);
    this.onBrushChange();
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
      const cp1x = x - 0.88 * (x - x0);
      const cp1y = y0;
      const cp2x = x - 0.12 * (x - x0);
      const cp2y = y;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
      x0 = x;
      y0 = y;
    });
    if (has_started) {
      ctx.lineTo(x0 + 15, y0); // right edge
    }
  }
}
