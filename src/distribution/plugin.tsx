/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import $ from "jquery";
import React from "react";
import _ from "underscore";
import { ResizableH } from "../lib/resizable";
import { isString, readState } from "../lib/savedstate";
import type { HiPlotPluginData } from "../plugin";
import { DistributionPlot, type HistogramData } from "./plot";

export interface HiPlotDistributionPluginState {
  initialHeight: number;
  height: number;
  width: number;
  axis: string | null;
  histData: HistogramData;
}

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

interface DistributionPluginProps extends HiPlotPluginData, DistributionDisplayData {}

export class HiPlotDistributionPlugin extends React.Component<
  DistributionPluginProps,
  HiPlotDistributionPluginState
> {
  container_ref = React.createRef<HTMLDivElement>();
  constructor(props: DistributionPluginProps) {
    super(props);
    const knownAxis = (candidate: string | undefined): string | null =>
      candidate && props.params_def[candidate] !== undefined ? candidate : null;
    const axis =
      knownAxis(readState(props.persistentState, "axis", isString, "")) ?? knownAxis(props.axis);
    const initialHeight = Math.min(Math.max(document.body.clientHeight - 540, 240), 500);
    this.state = {
      initialHeight: initialHeight,
      height: initialHeight,
      width: 0,
      histData: { selected: props.rows_selected, all: props.rows_filtered },
      axis: axis,
    };
  }
  static defaultProps = {
    nbins: 10,
    animateMs: 750,
  };

  componentDidMount() {
    if (this.props.context_menu_ref?.current) {
      this.props.context_menu_ref.current.addCallback((column, cm) => {
        const contextmenu = $(cm);
        contextmenu.append($('<div class="dropdown-divider"></div>'));
        const option = $('<a class="dropdown-item" href="#">').text("View distribution");
        if (this.state.axis === column) {
          option.addClass("disabled").css("pointer-events", "none");
        }
        option.click((event) => {
          this.setState({ axis: column });
          event.preventDefault();
        });
        contextmenu.append(option);
      }, this);
    }
  }
  componentDidUpdate(_prevProps: HiPlotPluginData, prevState: HiPlotDistributionPluginState) {
    if (prevState.axis !== this.state.axis) {
      this.props.sendMessage("height_changed", () => null);
      if (this.props.persistentState) {
        this.props.persistentState.set("axis", this.state.axis);
      }
    }
    if (this.state.histData.all !== this.props.rows_filtered) {
      this.setState((s: HiPlotDistributionPluginState) => ({
        histData: {
          ...s.histData,
          all: this.props.rows_filtered,
          selected: this.props.rows_selected,
        },
      }));
    } else if (this.state.histData.selected !== this.props.rows_selected) {
      this.setState((s: HiPlotDistributionPluginState) => ({
        histData: {
          ...s.histData,
          selected: this.props.rows_selected,
        },
      }));
    }
  }
  componentWillUnmount() {
    if (this.props.context_menu_ref?.current) {
      this.props.context_menu_ref.current.removeCallbacks(this);
    }
    this.onResize.cancel();
  }
  onResize = _.debounce((height: number, width: number) => {
    if (height !== this.state.height || width !== this.state.width) {
      this.setState({ height: height, width: width });
      this.props.sendMessage("height_changed", () => null);
    }
  }, 150);
  disable(): void {
    this.setState({ width: 0, axis: null, height: this.state.initialHeight });
  }
  render() {
    if (this.state.axis === null) {
      return [];
    }
    const param_def = this.props.params_def[this.state.axis];
    console.assert(param_def !== undefined, this.state.axis);
    return (
      <ResizableH
        initialHeight={this.state.height}
        onResize={this.onResize}
        onRemove={this.disable.bind(this)}
      >
        {this.state.width > 0 && (
          <DistributionPlot
            axis={this.state.axis}
            height={this.state.height}
            width={this.state.width}
            histData={this.state.histData}
            param_def={param_def}
            nbins={this.props.nbins}
            animateMs={this.props.animateMs}
          />
        )}
      </ResizableH>
    );
  }
}
