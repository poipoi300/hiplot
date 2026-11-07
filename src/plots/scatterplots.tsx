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
import { ResizableH } from "../lib/resizable";
import { isString, readState } from "../lib/savedstate";
import { PlotXY, type PlotXYDisplayData } from "../plotxy";
import type { HiPlotPluginData, PluginWindowState } from "../plugin";
import { ColumnSelect, PanelHeader, SectionBar } from "./frame";
import {
  isScatterPanels,
  nextPanelId,
  normalizeScatterPanel,
  type ScatterPanel,
  scatterKind,
} from "./panels";
import style from "./plots.module.css";
import { Scatter3D, type ScatterAxes } from "./scatter3d";

interface ScatterPlotsProps extends HiPlotPluginData, PlotXYDisplayData {}

interface ScatterPlotsState {
  panels: ScatterPanel[];
}

const KIND_LABELS = {
  empty: "Scatter",
  distribution: "Distribution of X",
  xy: "Scatter",
  xyz: "3D scatter",
} as const;

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
          />
        )}
      </ResizableH>
    );
  }
}

/**
 * The scatter plots: any number of panels, each closable, with X, Y and Z
 * picked in its header. X alone shows its distribution, X and Y an XY
 * scatter, all three a 3D scatter. The list is kept with the page state.
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
    this.state = { panels: saved.map((panel) => normalizeScatterPanel(panel, columns)) };
  }
  static defaultProps = PlotXY.defaultProps;

  componentDidMount() {
    this.props.context_menu_ref?.current?.addCallback((column, cm) => {
      const contextmenu = $(cm);
      contextmenu.append($('<div class="dropdown-divider"></div>'));
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
    const { x, y, z } = panel;
    if (x === null) {
      return (
        <div className={style.empty}>
          Pick X to see its distribution, add Y for a scatter plot and Z for a 3D scatter.
        </div>
      );
    }
    if (y === null) {
      return (
        <DistributionView
          key={x}
          {...this.props}
          nbins={20}
          animateMs={0}
          axis={x}
          onClose={close}
        />
      );
    }
    if (z === null) {
      return (
        <PlotXY
          key={`${x}\u0000${y}`}
          {...this.props}
          axis_x={x}
          axis_y={y}
          persistentState={this.props.persistentState.children(`panel${panel.id}`)}
          window_state={this.windowState(panel.id)}
          onClose={close}
        />
      );
    }
    return <Scatter3DPanel {...this.props} axes={{ x, y, z }} onClose={close} />;
  }
  render() {
    return (
      <section aria-label="Scatter plots" data-testid="scatter-plots">
        <SectionBar title="Scatter plots" addLabel="Add scatter plot" onAdd={this.addPanel} />
        {this.state.panels.map((panel) => (
          <div key={panel.id} className={style.panel} data-testid="scatter-panel">
            <PanelHeader name="scatter plot" onClose={() => this.closePanel(panel.id)}>
              <span className={style.panelKind}>{KIND_LABELS[scatterKind(panel)]}</span>
              <ColumnSelect
                label="X"
                value={panel.x}
                params_def={this.props.params_def}
                optional={false}
                onChange={(column) => this.updatePanel(panel.id, "x", column)}
              />
              {panel.x !== null && (
                <ColumnSelect
                  label="Y"
                  value={panel.y}
                  params_def={this.props.params_def}
                  optional={true}
                  onChange={(column) => this.updatePanel(panel.id, "y", column)}
                />
              )}
              {panel.y !== null && (
                <ColumnSelect
                  label="Z"
                  value={panel.z}
                  params_def={this.props.params_def}
                  optional={true}
                  onChange={(column) => this.updatePanel(panel.id, "z", column)}
                />
              )}
            </PanelHeader>
            {this.renderBody(panel)}
          </div>
        ))}
      </section>
    );
  }
}
