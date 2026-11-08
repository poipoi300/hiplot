/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import $ from "jquery";
import React from "react";
import _ from "underscore";
import { ColumnSelect } from "../lib/columnpicker";
import { fitColor } from "../lib/fitcolor";
import { ResizableH } from "../lib/resizable";
import { isString, readState } from "../lib/savedstate";
import { PanelHeader, pickableColumns, SectionBar } from "../plots/frame";
import { type DistributionPanel, isDistributionPanels, nextPanelId } from "../plots/panels";
import pstyle from "../plots/plots.module.css";
import type { HiPlotPluginData } from "../plugin";
import { DistributionPlot, type HistogramData } from "./plot";

// DISPLAYS_DATA_DOC_BEGIN
// Corresponds to values in the dict of `exp.display_data(hip.Displays.DISTRIBUTION)`
export interface DistributionDisplayData {
  // Number of bins for distribution of numeric variables
  nbins: number;

  // Animation duration in ms when data changes
  animateMs: number;

  // Default axis for the distribution plot
  axis?: string;
}
// DISPLAYS_DATA_DOC_END

interface DistributionViewProps extends HiPlotPluginData, DistributionDisplayData {
  axis: string;
  onClose: () => void;
}

interface DistributionViewState {
  height: number;
  width: number;
  histData: HistogramData;
}

const initialHeight = (): number => Math.min(Math.max(document.body.clientHeight - 540, 240), 500);

/** The histogram of one column: the selected rows over all filtered rows. */
export class DistributionView extends React.Component<
  DistributionViewProps,
  DistributionViewState
> {
  constructor(props: DistributionViewProps) {
    super(props);
    this.state = {
      height: initialHeight(),
      width: 0,
      histData: { selected: props.rows_selected, all: props.rows_filtered },
    };
  }
  componentDidUpdate(): void {
    if (this.state.histData.all !== this.props.rows_filtered) {
      this.setState((s) => ({
        histData: {
          ...s.histData,
          all: this.props.rows_filtered,
          selected: this.props.rows_selected,
        },
      }));
    } else if (this.state.histData.selected !== this.props.rows_selected) {
      this.setState((s) => ({ histData: { ...s.histData, selected: this.props.rows_selected } }));
    }
  }
  componentWillUnmount(): void {
    this.onResize.cancel();
  }
  onResize = _.debounce((height: number, width: number) => {
    if (height !== this.state.height || width !== this.state.width) {
      this.setState({ height: height, width: width });
      this.props.sendMessage("height_changed", () => null);
    }
  }, 150);
  render() {
    const param_def = this.props.params_def[this.props.axis];
    if (param_def === undefined) {
      throw new Error(`Distribution of unknown column ${this.props.axis}`);
    }
    return (
      <ResizableH
        initialHeight={this.state.height}
        onResize={this.onResize}
        onRemove={this.props.onClose}
      >
        {this.state.width > 0 && (
          <DistributionPlot
            axis={this.props.axis}
            height={this.state.height}
            width={this.state.width}
            histData={this.state.histData}
            param_def={param_def}
            nbins={this.props.nbins}
            animateMs={this.props.animateMs}
            highlighted={this.props.rows_highlighted}
            colorOf={(row) => this.props.get_color_for_row(row, 1)}
            fitColor={fitColor(
              this.props.color_binning.palette,
              this.props.dark ? "dark" : "light",
            )}
          />
        )}
      </ResizableH>
    );
  }
}

interface DistributionPluginProps extends HiPlotPluginData, DistributionDisplayData {}

interface DistributionPluginState {
  panels: DistributionPanel[];
}

/**
 * The distribution plots: any number of histograms, each closable and with
 * its column picked in its header. The list is kept with the page state.
 */
export class HiPlotDistributionPlugin extends React.Component<
  DistributionPluginProps,
  DistributionPluginState
> {
  constructor(props: DistributionPluginProps) {
    super(props);
    const knownAxis = (candidate: string | undefined | null): string | null =>
      candidate && props.params_def[candidate] !== undefined ? candidate : null;
    // Pages saved before several plots existed kept one axis.
    const legacyAxis =
      knownAxis(readState(props.persistentState, "axis", isString, "")) ?? knownAxis(props.axis);
    const saved = readState(
      props.persistentState,
      "panels",
      isDistributionPanels,
      legacyAxis === null ? [] : [{ id: "1", axis: legacyAxis }],
    );
    this.state = { panels: saved.map((panel) => ({ ...panel, axis: knownAxis(panel.axis) })) };
  }
  static defaultProps = {
    nbins: 10,
    animateMs: 750,
  };

  componentDidMount() {
    this.props.context_menu_ref?.current?.addCallback((column, cm) => {
      const contextmenu = $(cm);
      contextmenu.append($('<div class="dropdown-divider"></div>'));
      const option = $('<a class="dropdown-item" href="#">').text("View distribution");
      const last = this.state.panels[this.state.panels.length - 1];
      if (last?.axis === column) {
        option.addClass("disabled").css("pointer-events", "none");
      }
      option.on("click", (event) => {
        this.setLastAxis(column);
        event.preventDefault();
      });
      contextmenu.append(option);
    }, this);
  }
  componentDidUpdate(_prevProps: DistributionPluginProps, prevState: DistributionPluginState) {
    if (prevState.panels !== this.state.panels) {
      this.props.persistentState.set("panels", this.state.panels);
      this.props.sendMessage("height_changed", () => null);
    }
  }
  componentWillUnmount() {
    this.props.context_menu_ref?.current?.removeCallbacks(this);
  }
  /** Shows `column` in the last distribution plot, adding one when there is none. */
  setLastAxis(column: string): void {
    this.setState(({ panels }) => {
      if (panels.length === 0) {
        return { panels: [{ id: nextPanelId(panels), axis: column }] };
      }
      return { panels: [...panels.slice(0, -1), { ...panels[panels.length - 1], axis: column }] };
    });
  }
  addPanel = (): void => {
    this.setState(({ panels }) => ({
      panels: [...panels, { id: nextPanelId(panels), axis: null }],
    }));
  };
  updatePanel(id: string, axis: string | null): void {
    this.setState(({ panels }) => ({
      panels: panels.map((panel) => (panel.id === id ? { ...panel, axis } : panel)),
    }));
  }
  closePanel(id: string): void {
    this.setState(({ panels }) => ({ panels: panels.filter((panel) => panel.id !== id) }));
  }
  render() {
    return (
      <section aria-label="Distribution plots" data-testid="distribution-plots">
        <SectionBar title="Distributions" addLabel="Add distribution" onAdd={this.addPanel} />
        {this.state.panels.map((panel) => (
          <div key={panel.id} className={pstyle.panel} data-testid="distribution-panel">
            <PanelHeader name="distribution" onClose={() => this.closePanel(panel.id)}>
              <span className={pstyle.panelKind}>Distribution</span>
              <ColumnSelect
                axis="Column"
                columns={pickableColumns(this.props.params_def)}
                value={panel.axis}
                onChange={(axis) => this.updatePanel(panel.id, axis)}
              />
            </PanelHeader>
            {panel.axis === null ? (
              <div className={pstyle.empty}>Pick a column to see how its values are spread.</div>
            ) : (
              <DistributionView
                key={panel.axis}
                {...this.props}
                axis={panel.axis}
                onClose={() => this.closePanel(panel.id)}
              />
            )}
          </div>
        ))}
      </section>
    );
  }
}
