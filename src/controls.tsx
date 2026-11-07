/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import React from "react";
import style from "./hiplot.module.css";
import { mounted } from "./lib/refs";
import type { IDatasets } from "./types";

export interface HiPlotDataControlProps extends IDatasets {
  restoreAllRows: () => void;
  filterRows: (keep: boolean) => void;
}

interface HiPlotDataControlState {
  btnEnabled: boolean;
}

export abstract class KeepOrExcludeDataBtn extends React.Component<
  HiPlotDataControlProps,
  HiPlotDataControlState
> {
  btnRef = React.createRef<HTMLButtonElement>();
  abstract readonly keep: boolean;
  abstract readonly title: string;
  abstract readonly label: string;
  abstract readonly style: string;
  constructor(props: HiPlotDataControlProps) {
    super(props);
    this.state = {
      btnEnabled: this.btnEnabled(),
    };
  }
  btnEnabled(): boolean {
    return (
      0 < this.props.rows_selected.length &&
      this.props.rows_selected.length < this.props.rows_filtered.length
    );
  }
  componentDidUpdate() {
    if (this.state.btnEnabled !== this.btnEnabled()) {
      this.setState({ btnEnabled: this.btnEnabled() });
    }
  }
  onClick() {
    this.props.filterRows(this.keep);
  }
  render() {
    return (
      <button
        type="button"
        title={this.title}
        ref={this.btnRef}
        className={`btn btn-sm btn-${this.style}`}
        disabled={!this.state.btnEnabled}
        onClick={this.onClick.bind(this)}
      >
        {this.label}
      </button>
    );
  }
}

export class KeepDataBtn extends KeepOrExcludeDataBtn {
  readonly keep = true;
  readonly title = "Zoom in on selected data";
  readonly label = "Keep";
  readonly style = "success";
}

export class ExcludeDataBtn extends KeepOrExcludeDataBtn {
  readonly keep = false;
  readonly title = "Remove selected data";
  readonly label = "Exclude";
  readonly style = "danger";
}

function downloadURL(url: string, filename: string) {
  const element = document.createElement("a");
  element.setAttribute("href", url);
  element.setAttribute("download", filename);

  element.style.display = "none";
  document.body.appendChild(element);

  element.click();

  document.body.removeChild(element);
}

export class ExportDataCSVBtn extends React.Component<
  HiPlotDataControlProps,
  HiPlotDataControlState
> {
  onClick() {
    const all_selected = this.props.rows_selected;
    const csv: string = d3.csvFormat(all_selected);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    downloadURL(url, `hiplot-selected-${all_selected.length}.csv`);
  }

  render() {
    return (
      <button
        type="button"
        title="Export data as CSV"
        className="btn btn-sm btn-light"
        onClick={this.onClick.bind(this)}
      >
        Export
      </button>
    );
  }
}

export class RestoreDataBtn extends React.Component<
  HiPlotDataControlProps,
  HiPlotDataControlState
> {
  constructor(props: HiPlotDataControlProps) {
    super(props);
    this.state = {
      btnEnabled: this.btnEnabled(),
    };
  }
  btnEnabled(): boolean {
    return this.props.rows_all_unfiltered.length !== this.props.rows_filtered.length;
  }
  componentDidUpdate() {
    const btnEnabled = this.btnEnabled();
    if (btnEnabled !== this.state.btnEnabled) {
      this.setState({ btnEnabled: btnEnabled });
    }
  }
  onClick() {
    this.props.restoreAllRows();
  }

  render() {
    return (
      <button
        type="button"
        title="Remove all applied filters"
        className="btn btn-sm btn-sm btn-info"
        disabled={!this.state.btnEnabled}
        onClick={this.onClick.bind(this)}
      >
        Restore
      </button>
    );
  }
}

export class SelectedCountProgressBar extends React.Component<
  HiPlotDataControlProps,
  HiPlotDataControlState
> {
  selectedBar = React.createRef<HTMLDivElement>();
  componentDidMount() {
    this.updateBarWidth();
  }
  componentDidUpdate() {
    this.updateBarWidth();
  }
  updateBarWidth() {
    const selected = this.props.rows_selected.length;
    const filtered = this.props.rows_filtered.length;
    const selectedBar = mounted(this.selectedBar);
    selectedBar.style.width = `${(100 * selected) / filtered}%`;
  }

  render() {
    return (
      <div className={style.fillbar}>
        <div ref={this.selectedBar} className={style.selectedBar}>
          <div style={{ width: "100%" }} className={style.renderedBar}>
            &nbsp;
          </div>
        </div>
      </div>
    );
  }
}
