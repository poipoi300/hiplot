/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import $ from "jquery";
import React from "react";
import _ from "underscore";
import { DistributionView } from "../distribution/plugin";
import { lassoFilter } from "../filters";
import { ColumnSelect } from "../lib/columnpicker";
import { ResizableH } from "../lib/resizable";
import { isString, readState } from "../lib/savedstate";
import { PlotXY, type PlotXYDisplayData } from "../plotxy";
import { DefaultPlugins, type HiPlotPluginData, type PluginWindowState } from "../plugin";
import { PanelHeader, pickableColumns, SectionBar } from "./frame";
import {
  isScatterPanels,
  nextPanelId,
  normalizeScatterPanel,
  plottedColumns,
  type ScatterPanel,
  scatterKind,
  withOneAxisPanels,
} from "./panels";
import style from "./plots.module.css";
import { Scatter3D, type ScatterAxes } from "./scatter3d";

interface ScatterPlotsProps extends HiPlotPluginData, PlotXYDisplayData {
  /** Columns of distribution plots an older page saved, shown as one-axis panels. */
  migrated_distribution_axes?: ReadonlyArray<string>;
}

/** Bins of a one-axis plot, unless the experiment set them for its distribution plots. */
const DEFAULT_ONE_AXIS_BINS = 20;

interface ScatterPlotsState {
  panels: ScatterPanel[];
}

const KIND_LABELS = {
  empty: "Scatter",
  distribution: "Distribution",
  xy: "Scatter",
  xyz: "3D scatter",
} as const;

const AXES = ["x", "y", "z"] as const;

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || isString(value);

/** A 3D scatter in a frame that can be resized, or closed by dragging it shut. */
class Scatter3DPanel extends React.Component<
  ScatterPlotsProps & { axes: ScatterAxes; onClose: () => void },
  { width: number; height: number }
> {
  state = { width: 0, height: 460 };
  onResize = _.debounce((height: number, width: number) => {
    this.setState({ height, width });
  }, 100);
  componentWillUnmount(): void {
    this.onResize.cancel();
  }
  render() {
    return (
      <ResizableH
        initialHeight={this.state.height}
        onResize={this.onResize}
        onRemove={this.props.onClose}
      >
        {this.state.width > 0 && (
          <Scatter3D
            rows={this.props.rows_filtered}
            selected={this.props.rows_selected}
            params_def={this.props.params_def}
            axes={this.props.axes}
            color_binning={this.props.color_binning}
            colorby={this.props.colorby}
            dark={this.props.dark}
            width={this.state.width}
            height={this.state.height}
            render_row_text={this.props.render_row_text}
            setHighlighted={this.props.setHighlighted}
            onLasso={(rows) => this.props.setSelected(rows, lassoFilter(rows))}
          />
        )}
      </ResizableH>
    );
  }
}

/**
 * The scatter plots: any number of panels, each closable, with X, Y and Z
 * picked in its header, each a column or None. The columns set are plotted
 * in that order: one shows its distribution, two an XY scatter (the first
 * across), three a 3D scatter. The list is kept with the page state.
 */
export class ScatterPlots extends React.Component<ScatterPlotsProps, ScatterPlotsState> {
  /** Page-lifetime state (heights) of each panel's XY plot. */
  private windowStates = new Map<string, PluginWindowState>();

  constructor(props: ScatterPlotsProps) {
    super(props);
    // Pages saved before several plots existed kept one pair of axes.
    const legacy = (axis: "axis_x" | "axis_y"): string | null =>
      readState(props.persistentState, axis, isStringOrNull, props[axis]);
    const x = legacy("axis_x");
    const saved = readState(
      props.persistentState,
      "panels",
      isScatterPanels,
      x === null ? [] : [{ id: "1", x, y: legacy("axis_y"), z: null }],
    );
    const columns = new Set(Object.keys(props.params_def));
    this.state = {
      panels: withOneAxisPanels(saved, props.migrated_distribution_axes ?? []).map((panel) =>
        normalizeScatterPanel(panel, columns),
      ),
    };
  }
  static defaultProps = PlotXY.defaultProps;

  componentDidMount() {
    if ((this.props.migrated_distribution_axes ?? []).length > 0) {
      this.props.persistentState.set("panels", this.state.panels);
    }
    this.props.context_menu_ref?.current?.addCallback((column, cm) => {
      const contextmenu = $(cm);
      contextmenu.append($('<div class="dropdown-divider"></div>'));
      const distribution = $('<a class="dropdown-item" href="#">').text("View distribution");
      distribution.on("click", (event) => {
        this.showDistribution(column);
        event.preventDefault();
      });
      contextmenu.append(distribution);
      contextmenu.append($('<h6 class="dropdown-header">Scatter plot</h6>'));
      const last = this.state.panels[this.state.panels.length - 1];
      (["x", "y", "z"] as const).forEach((axis) => {
        const option = $('<a class="dropdown-item" href="#">').text(
          `Set as ${axis.toUpperCase()} axis`,
        );
        if (last?.[axis] === column) {
          option.addClass("disabled").css("pointer-events", "none");
        }
        option.on("click", (event) => {
          this.setLastAxis(axis, column);
          event.preventDefault();
        });
        contextmenu.append(option);
      });
    }, this);
  }
  componentDidUpdate(_prevProps: ScatterPlotsProps, prevState: ScatterPlotsState) {
    if (prevState.panels !== this.state.panels) {
      this.props.persistentState.set("panels", this.state.panels);
      this.props.sendMessage("height_changed", () => null);
    }
  }
  componentWillUnmount() {
    this.props.context_menu_ref?.current?.removeCallbacks(this);
  }
  private setPanels(update: (panels: ScatterPanel[]) => ScatterPanel[]): void {
    const columns = new Set(Object.keys(this.props.params_def));
    this.setState(({ panels }) => ({
      panels: update(panels).map((panel) => normalizeScatterPanel(panel, columns)),
    }));
  }
  /** Sets one coordinate of the last panel, adding a panel when there is none. */
  setLastAxis(axis: "x" | "y" | "z", column: string): void {
    this.setPanels((panels) => {
      if (panels.length === 0) {
        return [{ id: nextPanelId(panels), x: null, y: null, z: null, [axis]: column }];
      }
      const last = panels[panels.length - 1];
      return [...panels.slice(0, -1), { ...last, [axis]: column }];
    });
  }
  /** Shows the distribution of `column` in a one-axis panel, adding one unless it has one. */
  showDistribution(column: string): void {
    this.setPanels((panels) => withOneAxisPanels(panels, [column]));
  }
  addPanel = (): void => {
    this.setPanels((panels) => [...panels, { id: nextPanelId(panels), x: null, y: null, z: null }]);
  };
  updatePanel(id: string, axis: "x" | "y" | "z", column: string | null): void {
    this.setPanels((panels) =>
      panels.map((panel) => (panel.id === id ? { ...panel, [axis]: column } : panel)),
    );
  }
  closePanel(id: string): void {
    this.windowStates.delete(id);
    this.setPanels((panels) => panels.filter((panel) => panel.id !== id));
  }
  /** The bins the experiment set for its distribution plots, which one-axis panels now show. */
  private oneAxisBins(): number {
    const nbins = this.props.experiment.display_data?.[DefaultPlugins.DISTRIBUTION]?.nbins;
    return typeof nbins === "number" && Number.isInteger(nbins) && nbins > 0
      ? nbins
      : DEFAULT_ONE_AXIS_BINS;
  }
  private windowState(id: string): PluginWindowState {
    const existing = this.windowStates.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const created: PluginWindowState = {};
    this.windowStates.set(id, created);
    return created;
  }
  private renderBody(panel: ScatterPanel): React.ReactNode {
    const close = () => this.closePanel(panel.id);
    const [first, second, third] = plottedColumns(panel);
    if (first === undefined) {
      return (
        <div className={style.empty} data-testid="scatter-empty">
          Pick a column on X, Y or Z: one shows its distribution, two a scatter plot, three a 3D
          scatter.
        </div>
      );
    }
    if (second === undefined) {
      return (
        <DistributionView
          key={first}
          {...this.props}
          nbins={this.oneAxisBins()}
          animateMs={0}
          axis={first}
          onClose={close}
        />
      );
    }
    if (third === undefined) {
      return (
        <PlotXY
          key={`${first}\u0000${second}`}
          {...this.props}
          axis_x={first}
          axis_y={second}
          persistentState={this.props.persistentState.children(`panel${panel.id}`)}
          window_state={this.windowState(panel.id)}
          onClose={close}
        />
      );
    }
    return (
      <Scatter3DPanel {...this.props} axes={{ x: first, y: second, z: third }} onClose={close} />
    );
  }
  render() {
    const columns = pickableColumns(this.props.params_def);
    return (
      <section aria-label="Scatter plots" data-testid="scatter-plots">
        <SectionBar title="Scatter plots" addLabel="Add scatter plot" onAdd={this.addPanel} />
        {this.state.panels.map((panel) => (
          <div key={panel.id} className={style.panel} data-testid="scatter-panel">
            <PanelHeader name="scatter plot" onClose={() => this.closePanel(panel.id)}>
              <span className={style.panelKind}>{KIND_LABELS[scatterKind(panel)]}</span>
              {AXES.map((axis) => (
                <ColumnSelect
                  key={axis}
                  axis={axis.toUpperCase()}
                  columns={columns}
                  value={panel[axis]}
                  onChange={(column) => this.updatePanel(panel.id, axis, column)}
                />
              ))}
            </PanelHeader>
            {this.renderBody(panel)}
          </div>
        ))}
      </section>
    );
  }
}
