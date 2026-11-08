/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import React from "react";
import style from "../hiplot.module.css";
import { create_d3_scale_without_outliers, type ParamDef } from "../infertypes";
import {
  type CategoricalScale,
  type ContinuousScale,
  convert_to_categorical_input,
  getLogScaleTickValues,
  type Scale,
} from "../lib/d3_scales";
import { labelTextFromHtml } from "../lib/escape";
import { powerOfTenLabels } from "../lib/numberformat";
import { mounted } from "../lib/refs";
import { type Datapoint, ParamType } from "../types";
import { type ColumnFit, densityCurve, fitColumn } from "./fit";

const margin = { top: 20, right: 20, bottom: 50, left: 60 };

type DatapointBin = d3.Bin<Datapoint, number>;

type DrawHistogramFn = (
  hist: BinsDrawData,
  densityScale: d3.ScaleLinear<number, number>,
  animate: boolean,
  displayIndexByOriginal: number[],
) => void;

interface BinsDrawData {
  bins: DatapointBin[];
  g: SVGGElement;
  draw_fn: DrawHistogramFn;
}

/** The scales an axis is drawn from: ours, or the point scale of the reordered categories. */
interface RangeableAxisScale<Domain extends d3.AxisDomain> extends d3.AxisScale<Domain> {
  range(): number[];
  range(range: [number, number]): unknown;
}

function binBounds(bin: DatapointBin): { x0: number; x1: number } {
  if (bin.x0 === undefined || bin.x1 === undefined) {
    throw new Error("Histogram bin without bounds");
  }
  return { x0: bin.x0, x1: bin.x1 };
}

export interface HistogramData {
  all: Datapoint[];
  selected: Datapoint[];
}

export interface DistributionPlotData {
  height: number;
  width: number;
  nbins: number;
  axis: string;
  histData: HistogramData;
  param_def: ParamDef;
  animateMs: number;
  /** Rows hovered anywhere on the page, marked where their value falls. */
  highlighted: ReadonlyArray<Datapoint>;
  colorOf: (row: Datapoint) => string;
  /** Color of the fitted density, away from the data's colors. */
  fitColor: string;
}

/** Points of a density curve across the plot. */
const CURVE_STEPS = 160;
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** A highlighted row and where its value falls along the data axis, in pixels. */
interface HighlightMark {
  row: Datapoint;
  position: number;
}

// Inspired by https://www.d3-graph-gallery.com/graph/histogram_binSize.html
export class DistributionPlot extends React.Component<DistributionPlotData, Record<never, never>> {
  /**
   * Supports both vertical and horizontal bar plots.
   * Will switch to vertical if we are plotting categorical data with too many distinct values.
   */
  axisBottom = React.createRef<SVGGElement>();
  axisLeft = React.createRef<SVGGElement>();
  axisRight = React.createRef<SVGGElement>();
  axisBottomName = React.createRef<SVGGElement>();

  svgContainer = React.createRef<SVGGElement>();
  histAll = React.createRef<SVGGElement>();
  histSelected = React.createRef<SVGGElement>();
  highlightLayer = React.createRef<SVGGElement>();
  fitLayer = React.createRef<SVGGElement>();
  /** The fit of the selected values, kept while the selection and column are. */
  private fitCache: {
    rows: ReadonlyArray<Datapoint>;
    paramDef: ParamDef;
    fit: ColumnFit | null;
  } | null = null;
  /** Where a row's value falls along the data axis, as the bars were last drawn. */
  private positionOf: ((row: Datapoint) => number | null) | null = null;

  dataScale: Scale = create_d3_scale_without_outliers(this.props.param_def);

  isVertical() {
    /*
        Vertical:
        |     --
        | __  ||
        | ||  || ...
        +--------------

        Horizontal:
        | =========
        | ======
        | ==
        +--------------

        */
    return (
      this.props.param_def.type !== ParamType.CATEGORICAL ||
      this.props.param_def.distinct_values.length < 3
    );
  }
  figureWidth() {
    return this.props.width - margin.left - margin.right;
  }
  figureHeight() {
    return this.props.height - margin.top - margin.bottom;
  }
  applyLogScaleTicks(axis: d3.Axis<number>, dataScale: ContinuousScale, tickCount: number): void {
    if (this.props.param_def.type !== ParamType.NUMERICLOG) {
      return;
    }
    const tickValues = getLogScaleTickValues(dataScale.domain(), tickCount);
    if (tickValues === null) {
      return;
    }
    const labels = powerOfTenLabels(tickValues);
    axis.tickValues(tickValues).tickFormat((_value, index) => labels[index]);
  }
  createDataAxis(dataScale: Scale | d3.ScalePoint<string>, animate: boolean): void {
    if ("kind" in dataScale && dataScale.kind === "continuous") {
      this.drawDataAxis<number>(
        dataScale,
        (axis, tickCount) => this.applyLogScaleTicks(axis, dataScale, tickCount),
        animate,
      );
      return;
    }
    this.drawDataAxis<string>(dataScale, () => undefined, animate);
  }
  drawDataAxis<Domain extends d3.AxisDomain>(
    dataScale: RangeableAxisScale<Domain>,
    configureAxis: (axis: d3.Axis<Domain>, tickCount: number) => void,
    animate: boolean,
  ): void {
    if (this.isVertical()) {
      dataScale.range([0, this.figureWidth()]);
      const tickCount = 1 + this.props.width / 50;
      const axis = d3.axisBottom(dataScale).ticks(tickCount);
      configureAxis(axis, tickCount);
      d3.select(mounted(this.axisBottom)).call(axis);
      d3.select(mounted(this.axisBottomName))
        .html(null)
        .append("text")
        .attr("text-anchor", "middle")
        .attr("font-weight", "bold")
        .attr("fill", "currentColor")
        .text(labelTextFromHtml(this.props.param_def.label_html, this.props.axis));
      mounted(this.axisRight).innerHTML = "";
    } else {
      dataScale.range([this.figureHeight(), 0]);
      const tickCount = 1 + this.props.height / 50;
      const axisRight = d3.axisRight(dataScale).ticks(tickCount);
      const axisLeft = d3.axisLeft(dataScale).ticks(tickCount);
      configureAxis(axisRight, tickCount);
      configureAxis(axisLeft, tickCount);
      d3.select(mounted(this.axisRight))
        .transition()
        .duration(animate ? this.props.animateMs : 0)
        .call(axisRight)
        .attr("text-anchor", "end");
      d3.select(mounted(this.axisLeft))
        .transition()
        .duration(animate ? this.props.animateMs : 0)
        .call(axisLeft);
      d3.select(mounted(this.axisBottomName))
        .html(null)
        .append("text")
        .attr("text-anchor", "middle")
        .attr("font-weight", "bold")
        .attr("fill", "currentColor")
        .text("Density");
    }
  }
  createDataScaleAndAxis(): void {
    this.dataScale = create_d3_scale_without_outliers(this.props.param_def);
    this.createDataAxis(this.dataScale, false);
  }

  categoricalDataScale(): CategoricalScale {
    if (this.dataScale.kind !== "categorical") {
      throw new Error(`Column "${this.props.axis}" does not have a categorical scale`);
    }
    return this.dataScale;
  }

  createHistogram(): d3.HistogramGeneratorNumber<Datapoint, number> {
    const thresholds: number[] = [];
    let valueFn: (d: Datapoint) => number;
    if (this.dataScale.kind === "categorical") {
      const domain = this.dataScale.domain();
      const domainCount = domain.length;
      const indexByValue = new Map(domain.map((value, index) => [value, index]));
      for (let i = 1; i < domainCount; ++i) {
        thresholds.push(i / domainCount);
      }
      valueFn = (d) => {
        if (!domainCount) {
          return NaN;
        }
        const key = convert_to_categorical_input(d[this.props.axis]);
        const idx = indexByValue.get(key);
        if (idx === undefined) {
          return NaN;
        }
        return (idx + 0.5) / domainCount;
      };
    } else {
      for (let i = 1; i < this.props.nbins; ++i) {
        thresholds.push(i / this.props.nbins);
      }
      const scaleCopy = this.dataScale.copy().range([0, 1]);
      valueFn = (d) => scaleCopy(d[this.props.axis]);
    }
    const histogram = d3
      .histogram<Datapoint, number>()
      .value(valueFn)
      .domain([0, 1])
      .thresholds(thresholds);
    return histogram;
  }

  drawAllHistograms(animate: boolean) {
    const histogram = this.createHistogram();
    const allHist: { selected: BinsDrawData; all: BinsDrawData } = {
      selected: {
        bins: histogram(this.props.histData.selected),
        g: mounted(this.histAll),
        draw_fn: this.drawHistogramRects.bind(this),
      },
      all: {
        bins: histogram(this.props.histData.all),
        g: mounted(this.histSelected),
        draw_fn: this.drawHistogramLines.bind(this),
      },
    };

    // Density axis: set max based on maximum in histogram
    const maxDensityHistogram = Math.max(
      ...Object.values(allHist).flatMap((hist) => {
        const total = d3.sum(hist.bins, (d) => d.length);
        return total ? hist.bins.map((d) => d.length / total) : [0];
      }),
    );
    // The fitted density of the selection, in the histogram's units, sets the
    // scale's top too: a narrow peak must not leave the plot.
    const curves = this.fitCurves(allHist.all.bins.length);
    const maxCurve = Math.max(0, ...curves.flatMap((curve) => curve.points.map(([, y]) => y)));
    let densityScale = d3
      .scaleLinear()
      .domain([0, Math.max(maxDensityHistogram, Math.min(maxCurve, 2 * maxDensityHistogram))]);
    // Map from original bin index -> displayed slot index.
    // In horizontal categorical mode we reorder categories by selected density.
    const displayIndexByOriginal = allHist.all.bins.map((_, i) => i);
    if (this.isVertical()) {
      densityScale = densityScale.range([this.figureHeight(), 0]);
      d3.select(mounted(this.axisLeft))
        .transition()
        .duration(animate ? this.props.animateMs : 0)
        .call(
          d3
            .axisLeft(densityScale)
            .ticks(1 + this.props.height / 50)
            .tickSizeInner(-(this.props.width - margin.left - margin.right)),
        );
    } else {
      densityScale = densityScale.range([0, this.figureWidth()]);
      d3.select(mounted(this.axisBottom))
        .transition()
        .duration(animate ? this.props.animateMs : 0)
        .call(d3.axisBottom(densityScale).ticks(1 + this.props.width / 50));
      // Compute reordering of the bins - we want to display higher densities first.
      const ordered1 = Array.from(displayIndexByOriginal)
        .map((value, index) => ({
          index: value,
          count: allHist.selected.bins[value].length,
          original: index,
        }))
        .sort((a, b) => {
          if (a.count !== b.count) {
            return a.count - b.count;
          }
          return a.original - b.original;
        })
        .map((entry) => entry.index);
      ordered1.forEach((value, idx) => {
        displayIndexByOriginal[value] = idx;
      });
      // Update ticks/axis as well
      const domain = this.categoricalDataScale().domain();
      const domainsOrdered = domain.map((_value, idx) => domain[ordered1[idx]]);
      this.createDataAxis(
        d3.scalePoint<string>().domain(domainsOrdered).range(this.dataScale.range()),
        true,
      );
    }

    // Draw all the histograms
    Object.values(allHist).forEach((v) => {
      v.draw_fn(v, densityScale, animate, displayIndexByOriginal);
    });
    const along = d3.scaleLinear().range(this.dataScale.range());
    const line = d3
      .line<[number, number]>()
      .x(([position]) => along(position))
      .y(([, share]) => densityScale(Math.min(share, densityScale.domain()[1])));
    d3.select(mounted(this.fitLayer))
      .selectAll<SVGPathElement, (typeof curves)[number]>("path")
      .data(curves, (curve) => curve.kind)
      .join("path")
      .attr("class", (curve) => (curve.kind === "fit" ? style.densityFit : style.densityKde))
      .attr("data-testid", (curve) => `density-${curve.kind}`)
      .attr("stroke", (curve) => (curve.kind === "fit" ? this.props.fitColor : null))
      .attr("d", (curve) => line(curve.points));

    const fractionOf = histogram.value();
    const pixelOf = d3.scaleLinear().range(this.dataScale.range());
    const binCount = allHist.all.bins.length;
    const vertical = this.isVertical();
    this.positionOf = (row) => {
      const fraction = fractionOf(row, 0, []);
      if (!Number.isFinite(fraction)) {
        return null;
      }
      if (vertical) {
        return pixelOf(fraction);
      }
      // Categories reordered by density sit at their display slot.
      const bin = Math.min(binCount - 1, Math.floor(fraction * binCount));
      return pixelOf((displayIndexByOriginal[bin] + 0.5) / binCount);
    };
    this.drawHighlight();
  }

  /** The fit of the selected values of a continuous column; null for categories. */
  columnFit(): ColumnFit | null {
    if (this.props.param_def.type === ParamType.CATEGORICAL) {
      return null;
    }
    const rows = this.props.histData.selected;
    const cached = this.fitCache;
    if (cached !== null && cached.rows === rows && cached.paramDef === this.props.param_def) {
      return cached.fit;
    }
    const axis = this.props.axis;
    const values = rows.map((row) => row[axis]).filter((value) => typeof value === "number");
    const fit = fitColumn(
      values,
      this.props.param_def.type === ParamType.NUMERICLOG ? "log" : "linear",
    );
    this.fitCache = { rows, paramDef: this.props.param_def, fit };
    return fit;
  }

  /** The fitted density and its KDE reference as shares of `binCount` bins along the axis. */
  private fitCurves(binCount: number): Array<{ kind: "fit" | "kde"; points: [number, number][] }> {
    const fit = this.columnFit();
    if (fit === null || this.dataScale.kind !== "continuous") {
      return [];
    }
    const valueAt = this.dataScale.copy().range([0, 1]);
    const at = (position: number) => valueAt.invert(position);
    const curves: Array<{ kind: "fit" | "kde"; points: [number, number][] }> = [
      { kind: "fit", points: densityCurve((x) => fit.best.pdf(x), at, binCount, CURVE_STEPS) },
    ];
    const kde = fit.kde;
    if (kde !== null) {
      curves.push({
        kind: "kde",
        points: densityCurve((x) => kde.pdf(x), at, binCount, CURVE_STEPS),
      });
    }
    return curves;
  }

  /** What the fitted curve is: the distribution, its formula and how it was chosen. */
  private renderFitCaption(): React.ReactNode {
    if (this.props.param_def.type === ParamType.CATEGORICAL) {
      return null;
    }
    const fit = this.columnFit();
    if (fit === null) {
      return (
        <div className={style.fitCaption} data-testid="distribution-fit">
          No density fit: too few distinct selected values.
        </div>
      );
    }
    const { best, runnerUp } = fit;
    const sample =
      fit.fitted < fit.total
        ? `fitted on an even sample of ${COUNT_FORMAT.format(fit.fitted)} of ${COUNT_FORMAT.format(fit.total)} values`
        : `n = ${COUNT_FORMAT.format(fit.total)}`;
    return (
      <div className={style.fitCaption} data-testid="distribution-fit">
        <div>
          <span className={style.fitSwatch} style={{ background: this.props.fitColor }} />
          <strong>{best.label}</strong>: {best.formula}
        </div>
        <div className={style.fitMethod}>
          Lowest BIC of the candidates (normal, log-normal, exponential, gamma, beta on (0, 1),
          Student t)
          {runnerUp === null
            ? ""
            : `; next: ${runnerUp.label}, ΔBIC ${(runnerUp.bic - best.bic).toFixed(1)}`}
          ; dashed: kernel density estimate; {sample}.
        </div>
      </div>
    );
  }

  /** A line across the plot at each highlighted row's value, in the row's color. */
  drawHighlight(): void {
    const positionOf = this.positionOf;
    const marks: HighlightMark[] =
      positionOf === null
        ? []
        : this.props.highlighted.flatMap((row) => {
            const position = positionOf(row);
            return position === null ? [] : [{ row, position }];
          });
    const vertical = this.isVertical();
    const across = vertical ? this.figureHeight() : this.figureWidth();
    d3.select(mounted(this.highlightLayer))
      .selectAll<SVGGElement, HighlightMark>("g")
      .data(marks)
      .join((enter) => {
        const mark = enter.append("g").attr("data-testid", "distribution-highlight");
        mark.append("line").classed(style.distributionHighlightHalo, true);
        mark.append("line").classed(style.distributionHighlight, true);
        return mark;
      })
      .each(function (this: SVGGElement, mark) {
        d3.select(this)
          .selectAll("line")
          .attr("x1", vertical ? mark.position : 0)
          .attr("x2", vertical ? mark.position : across)
          .attr("y1", vertical ? 0 : mark.position)
          .attr("y2", vertical ? across : mark.position);
      })
      .select(`.${style.distributionHighlight}`)
      .attr("stroke", (mark) => this.props.colorOf(mark.row));
  }

  drawHistogramLines(
    hist: BinsDrawData,
    densityScale: d3.ScaleLinear<number, number>,
    animate: boolean,
    displayIndexByOriginal: number[],
  ) {
    const total = d3.sum(hist.bins, (d) => d.length);
    const densityScaleFromLength = (d: DatapointBin) => densityScale(total ? d.length / total : 0);
    const dataScale = d3.scaleLinear().range(this.dataScale.range());

    const u = d3.select(hist.g).selectAll<SVGLineElement, DatapointBin>("line").data(hist.bins);

    const dataCoord = this.isVertical() ? "x" : "y";
    const densityCoord = this.isVertical() ? "y" : "x";
    u.enter()
      .append("line") // Add a new rect for each new elements
      .merge(u) // get the already existing elements as well
      .transition() // and apply changes to all of them
      .duration(animate ? this.props.animateMs : 0)
      .attr(
        `${dataCoord}1`,
        (_d, i) => dataScale(binBounds(hist.bins[displayIndexByOriginal[i]]).x0) + 1,
      )
      .attr(`${densityCoord}1`, (d) => densityScaleFromLength(d))
      .attr(`${dataCoord}2`, (_d, i) =>
        dataScale(binBounds(hist.bins[displayIndexByOriginal[i]]).x1),
      )
      .attr(`${densityCoord}2`, (d) => densityScaleFromLength(d));

    u.exit().remove();
  }

  drawHistogramRects(
    hist: BinsDrawData,
    densityScale: d3.ScaleLinear<number, number>,
    animate: boolean,
    displayIndexByOriginal: number[],
  ) {
    const total = d3.sum(hist.bins, (d) => d.length);
    const densityScaleFromLength = (d: DatapointBin) => densityScale(total ? d.length / total : 0);
    const dataScale = d3.scaleLinear().range(this.dataScale.range());
    const u = d3.select(hist.g).selectAll<SVGRectElement, DatapointBin>("rect").data(hist.bins);

    const ut = u
      .enter()
      .append("rect") // Add a new rect for each new elements
      .merge(u) // get the already existing elements as well
      .attr("data-value-sample", (d) => (d.length ? (d[0][this.props.axis] ?? null) : "empty"))
      .on("mouseover", function (this: SVGRectElement) {
        d3.select(this).transition().duration(150).attr("opacity", ".5");
      })
      .on("mouseout", function (this: SVGRectElement) {
        d3.select(this).transition().duration(150).attr("opacity", "1");
      })
      .transition() // and apply changes to all of them
      .duration(animate ? this.props.animateMs : 0);

    if (this.isVertical()) {
      ut.attr("x", 1)
        .attr("transform", (d) => {
          const { x0 } = binBounds(d);
          return `translate(${dataScale(x0)},${densityScaleFromLength(d)})`;
        })
        .attr("width", (d) => {
          const { x0, x1 } = binBounds(d);
          return dataScale(x1) - dataScale(x0) - 1;
        })
        .attr("height", (d) => this.figureHeight() - densityScaleFromLength(d));
    } else {
      ut
        //.attr("y", 1)
        .attr(
          "transform",
          (_d, i) =>
            `translate(0,${dataScale(binBounds(hist.bins[displayIndexByOriginal[i]]).x1)})`,
        )
        .attr("width", (d) => densityScaleFromLength(d))
        .attr("height", (_d, i) => {
          const { x0, x1 } = binBounds(hist.bins[displayIndexByOriginal[i]]);
          const delta = Math.abs(dataScale(x1) - dataScale(x0));
          return delta > 2 ? delta - 1 : delta;
        });
    }

    u.exit().remove();
  }
  componentDidMount() {
    this.createDataAxis(this.dataScale, false);
    this.drawAllHistograms(false);
  }

  componentDidUpdate(prevProps: DistributionPlotData) {
    if (
      prevProps.axis !== this.props.axis ||
      prevProps.param_def !== this.props.param_def ||
      prevProps.width !== this.props.width ||
      prevProps.height !== this.props.height
    ) {
      this.createDataScaleAndAxis();
    }
    if (
      prevProps.axis !== this.props.axis ||
      prevProps.param_def !== this.props.param_def ||
      prevProps.nbins !== this.props.nbins ||
      prevProps.histData !== this.props.histData ||
      prevProps.width !== this.props.width ||
      prevProps.height !== this.props.height
    ) {
      const animate =
        prevProps.nbins !== this.props.nbins || prevProps.histData !== this.props.histData;
      this.drawAllHistograms(animate);
    } else if (prevProps.highlighted !== this.props.highlighted) {
      this.drawHighlight();
    }
  }

  render() {
    return (
      <div data-testid="distribution-plot" data-axis={this.props.axis}>
        <svg
          width={this.props.width}
          height={this.props.height}
          role="img"
          aria-label={`Distribution of ${this.props.axis}`}
        >
          <text
            x={13}
            y={15}
            textAnchor="start"
            fontWeight="bold"
            fill="currentColor"
            className={style.axisLabelText}
          >
            {this.isVertical()
              ? "Density"
              : labelTextFromHtml(this.props.param_def.label_html, this.props.axis)}
          </text>
          <g
            ref={this.svgContainer}
            className={style["distr-graph-svg"]}
            transform={`translate(${margin.left}, ${margin.top})`}
          >
            <g data-testid="distribution-hist-all" className={style.histAll} ref={this.histAll}></g>
            <g
              data-testid="distribution-hist-selected"
              className={style.histSelected}
              ref={this.histSelected}
            ></g>
            <g ref={this.fitLayer} pointerEvents="none"></g>
            <g ref={this.highlightLayer} pointerEvents="none"></g>
            <g className="axisLeft" ref={this.axisLeft}></g>
            <g
              className="axisRight"
              ref={this.axisRight}
              transform={`translate(${this.figureWidth()}, 0)`}
            ></g>
            <g
              className="axisBottom"
              ref={this.axisBottom}
              transform={`translate(0, ${this.figureHeight()})`}
            ></g>
            <g
              ref={this.axisBottomName}
              transform={`translate(${this.figureWidth() / 2}, ${this.props.height - margin.top - 10})`}
              textAnchor="middle"
              fontWeight="bold"
            ></g>
          </g>
        </svg>
        {this.renderFitCaption()}
      </div>
    );
  }
}
