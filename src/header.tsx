/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import React from "react";
import IconSVG from "../hiplot/static/icon.svg";
import IconSVGW from "../hiplot/static/icon-w.svg";
import {
  ExcludeDataBtn,
  ExportDataCSVBtn,
  type HiPlotDataControlProps,
  KeepDataBtn,
  RestoreDataBtn,
} from "./controls";
import style from "./hiplot.module.css";
import controls from "./lib/controls.module.css";
import { mounted } from "./lib/refs";
import type { PersistentState } from "./lib/savedstate";
import { THEME_CHOICES, type ThemeChoice } from "./lib/theme";
import type { DataProviderClass, DataProviderComponent, DataProviderProps } from "./plugin";

import { HiPlotTutorial } from "./tutorial/tutorial";
import { type Datapoint, HiPlotLoadStatus, type IDatasets, type LoadURIPromise } from "./types";

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

const THEME_LABELS: { [choice in ThemeChoice]: { label: string; title: string } } = {
  light: { label: "Light", title: "Light theme" },
  dark: { label: "Dark", title: "Dark theme" },
  system: { label: "System", title: "Follow the system's light or dark setting" },
};

/** Light / Dark / System: the theme, remembered across pages. */
function ThemeToggle({
  choice,
  onChange,
}: {
  choice: ThemeChoice;
  onChange: (choice: ThemeChoice) => void;
}): React.ReactElement {
  return (
    <fieldset className={`${controls.segmented} ${style.themeToggle}`} aria-label="Theme">
      {THEME_CHOICES.map((option) => (
        <button
          key={option}
          type="button"
          title={THEME_LABELS[option].title}
          aria-pressed={choice === option}
          onClick={() => onChange(option)}
        >
          {THEME_LABELS[option].label}
        </button>
      ))}
    </fieldset>
  );
}

interface HeaderBarProps extends IDatasets, HiPlotDataControlProps {
  weightColumn?: string;
  loadStatus: HiPlotLoadStatus; // Should not allow to load an xp when already loading another xp
  persistentState: PersistentState;
  onLoadExperiment: (load_promise: LoadURIPromise) => void;

  dark: boolean;
  themeChoice: ThemeChoice;
  onThemeChoice: (choice: ThemeChoice) => void;
  dataProvider: DataProviderClass;

  // Optional: restore hidden columns in parallel plot
  restorableColumnsCount?: number;
  onRestoreColumns?: () => void;
}

interface HeaderBarState {
  isTextareaFocused: boolean;
  hasTutorial: boolean;
  selectedPct: string;
  selectedPctWeighted: string;
}

export class HeaderBar extends React.Component<HeaderBarProps, HeaderBarState> {
  dataProviderRef = React.createRef<DataProviderComponent>();
  controls_root_ref = React.createRef<HTMLDivElement>();

  constructor(props: HeaderBarProps) {
    super(props);
    this.state = {
      isTextareaFocused: false,
      hasTutorial: false,
      selectedPct: "???",
      selectedPctWeighted: "???",
    };
  }
  recomputeMetrics() {
    const newSelectedPct = (
      (100 * this.props.rows_selected.length) /
      this.props.rows_filtered.length
    ).toPrecision(3);
    if (newSelectedPct !== this.state.selectedPct) {
      this.setState({
        selectedPct: (
          (100 * this.props.rows_selected.length) /
          this.props.rows_filtered.length
        ).toPrecision(3),
      });
    }
  }
  recomputeSelectedWeightedSum() {
    if (!this.props.weightColumn) {
      this.setState({
        selectedPctWeighted: "???",
      });
      return;
    }
    const weightColumn = this.props.weightColumn;
    const getWeight = (dp: Datapoint): number => {
      const w = parseFloat(String(dp[weightColumn]));
      return !Number.isNaN(w) && Number.isFinite(w) && w > 0.0 ? w : 1.0;
    };
    let totalWeightFiltered = 0.0,
      totalWeightSelected = 0.0;
    this.props.rows_filtered.forEach((dp: Datapoint) => {
      totalWeightFiltered += getWeight(dp);
    });
    this.props.rows_selected.forEach((dp: Datapoint) => {
      totalWeightSelected += getWeight(dp);
    });
    const pctage = (100 * totalWeightSelected) / totalWeightFiltered;
    console.assert(!Number.isNaN(pctage), {
      pctage: pctage,
      totalWeightFiltered: totalWeightFiltered,
      totalWeightSelected: totalWeightSelected,
    });
    this.setState({
      selectedPctWeighted: pctage.toPrecision(3),
    });
  }
  componentDidMount() {
    this.recomputeMetrics();
    this.recomputeSelectedWeightedSum();
  }
  componentDidUpdate(prevProps: HeaderBarProps, _prevState: HeaderBarState): void {
    this.recomputeMetrics();
    if (
      prevProps.weightColumn !== this.props.weightColumn ||
      this.props.rows_selected !== prevProps.rows_selected ||
      this.props.rows_filtered !== prevProps.rows_filtered
    ) {
      this.recomputeSelectedWeightedSum();
    }
  }
  onToggleTutorial() {
    this.setState((prevState, _prevProps) => ({
      hasTutorial: !prevState.hasTutorial,
    }));
  }
  onRefresh() {
    const promise = mounted(this.dataProviderRef).refresh?.();
    if (promise) {
      this.props.onLoadExperiment(promise);
    }
  }
  renderControls() {
    const dataProviderProps: React.ClassAttributes<DataProviderComponent> & DataProviderProps = {
      ref: this.dataProviderRef,
      persistentState: this.props.persistentState,
      loadStatus: this.props.loadStatus,
      hasFocus: this.state.isTextareaFocused,
      onFocusChange: (hasFocus: boolean) => this.setState({ isTextareaFocused: hasFocus }),
      onLoadExperiment: this.props.onLoadExperiment,
    };
    return (
      <React.Fragment>
        {React.createElement(this.props.dataProvider, dataProviderProps)}

        {this.props.loadStatus === HiPlotLoadStatus.Loaded && !this.state.isTextareaFocused && (
          <React.Fragment>
            <div className={style.controlGroup}>
              <RestoreDataBtn {...this.props} />
              <KeepDataBtn {...this.props} />
              <ExcludeDataBtn {...this.props} />
              {this.dataProviderRef.current?.refresh && (
                <button
                  type="button"
                  title="Refresh"
                  className="btn btn-sm btn-light"
                  onClick={this.onRefresh.bind(this)}
                >
                  Refresh
                </button>
              )}
              <ExportDataCSVBtn {...this.props} />
              <button
                type="button"
                title="Start HiPlot tutorial"
                className="btn btn-sm btn-light"
                onClick={this.onToggleTutorial.bind(this)}
              >
                Help
              </button>
              {this.props.restorableColumnsCount !== undefined &&
                this.props.restorableColumnsCount > 0 &&
                this.props.onRestoreColumns && (
                  <button
                    type="button"
                    title="Restore hidden columns in parallel plot"
                    className="btn btn-sm btn-light"
                    onClick={this.props.onRestoreColumns}
                  >
                    Restore {this.props.restorableColumnsCount} column
                    {this.props.restorableColumnsCount > 1 ? "s" : ""}
                  </button>
                )}

              <div style={{ clear: "both" }}></div>
            </div>
            <div className={style.controlGroup}>
              <div
                className={style.selectionCount}
                data-testid="selection-count"
                aria-live="polite"
              >
                <strong>{COUNT_FORMAT.format(this.props.rows_selected.length)}</strong>
                <span> of {COUNT_FORMAT.format(this.props.rows_filtered.length)} selected</span>
                <span className={style.selectionShare}>
                  {this.props.weightColumn
                    ? `${this.state.selectedPctWeighted}% weighted`
                    : `${this.state.selectedPct}%`}
                </span>
              </div>
            </div>
          </React.Fragment>
        )}
      </React.Fragment>
    );
  }
  render() {
    return (
      <div ref={this.controls_root_ref} className={`container-fluid ${style.header}`}>
        <div className={"d-flex flex-wrap"}>
          <img style={{ height: "55px" }} src={this.props.dark ? IconSVGW : IconSVG} alt="HiPlot" />
          {this.renderControls()}
          <ThemeToggle choice={this.props.themeChoice} onChange={this.props.onThemeChoice} />
        </div>
        {this.state.hasTutorial && (
          <HiPlotTutorial
            navbarRoot={this.controls_root_ref}
            onTutorialDone={(() => this.setState({ hasTutorial: false })).bind(this)}
          />
        )}
      </div>
    );
  }
}

interface ErrorDisplayProps {
  error: string;
}

export class ErrorDisplay extends React.Component<ErrorDisplayProps> {
  render() {
    return (
      <div className="alert alert-danger" role="alert">
        <div className="container">
          <h4 className="alert-heading">{this.props.error}</h4>
          <p className="mb-0">
            HiPlot encountered the error above - more information might be available in your
            browser's developer web console, or in the server output
          </p>
        </div>
      </div>
    );
  }
}
