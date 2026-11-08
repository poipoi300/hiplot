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

/** Stroked 16 px icons of the theme choices, in the controls' line weight. */
const THEME_ICONS: { [choice in ThemeChoice]: React.ReactElement } = {
  light: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <circle cx="8" cy="8" r="2.9" />
        <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" />
      </g>
    </svg>
  ),
  dark: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13.4 10.1A5.8 5.8 0 0 1 5.9 2.6a5.8 5.8 0 1 0 7.5 7.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ),
  system: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <rect x="1.7" y="2.5" width="12.6" height="8.6" rx="1.4" />
        <path d="M5.5 14h5M8 11.1V14" />
      </g>
    </svg>
  ),
};

const THEME_LABELS: { [choice in ThemeChoice]: { label: string; title: string } } = {
  light: { label: "Light", title: "Light theme" },
  dark: { label: "Dark", title: "Dark theme" },
  system: { label: "System", title: "Follow the system's light or dark setting" },
};

/** A circular arrow: load the experiment again. */
const REFRESH_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13.1 8.6A5.2 5.2 0 1 1 11.6 4.1" />
      <path d="M12.2 1.6v3h-3" />
    </g>
  </svg>
);

/** Light / Dark / System as icons: the theme, remembered across pages. */
function ThemeToggle({
  choice,
  onChange,
}: {
  choice: ThemeChoice;
  onChange: (choice: ThemeChoice) => void;
}): React.ReactElement {
  return (
    <fieldset
      className={`${controls.segmented} ${controls.iconSegmented} ${style.themeToggle}`}
      aria-label="Theme"
    >
      {THEME_CHOICES.map((option) => (
        <button
          key={option}
          type="button"
          title={THEME_LABELS[option].title}
          aria-label={THEME_LABELS[option].label}
          aria-pressed={choice === option}
          onClick={() => onChange(option)}
        >
          {THEME_ICONS[option]}
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

  /** The color legend, shown in the row once an experiment is loaded. */
  legend: React.ReactNode;
  /** Where displays put their controls in the row (see HiPlotPluginData.header_toolbar). */
  onToolbarSlot: (slot: HTMLDivElement | null) => void;
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
    const showControls =
      this.props.loadStatus === HiPlotLoadStatus.Loaded && !this.state.isTextareaFocused;
    return (
      <React.Fragment>
        {React.createElement(this.props.dataProvider, dataProviderProps)}
        {showControls && this.dataProviderRef.current?.refresh && (
          <button
            type="button"
            title="Load the experiment again"
            aria-label="Refresh"
            className={`${controls.button} ${controls.iconButton}`}
            onClick={this.onRefresh.bind(this)}
          >
            {REFRESH_ICON}
          </button>
        )}

        {showControls && (
          <React.Fragment>
            <div className={style.controlGroup}>
              <RestoreDataBtn {...this.props} />
              <KeepDataBtn {...this.props} />
              <ExcludeDataBtn {...this.props} />
            </div>
            <div className={style.selectionCount} data-testid="selection-count" aria-live="polite">
              <strong>{COUNT_FORMAT.format(this.props.rows_selected.length)}</strong>
              <span>
                of {COUNT_FORMAT.format(this.props.rows_filtered.length)}
                <span className={style.selectionWord}> selected</span>
              </span>
              <span className={style.selectionShare}>
                {this.props.weightColumn
                  ? `${this.state.selectedPctWeighted}% weighted`
                  : `${this.state.selectedPct}%`}
              </span>
            </div>
            {this.props.legend}
          </React.Fragment>
        )}
        {/* Kept mounted, so controls portalled here survive a focused textarea. */}
        <div
          ref={this.props.onToolbarSlot}
          className={style.toolbarSlot}
          hidden={!showControls}
          data-testid="header-toolbar"
        />
        {showControls && (
          <div className={style.controlGroup}>
            <ExportDataCSVBtn {...this.props} />
            <button
              type="button"
              title="Start HiPlot tutorial"
              className={controls.button}
              onClick={this.onToggleTutorial.bind(this)}
            >
              Help
            </button>
          </div>
        )}
      </React.Fragment>
    );
  }
  render() {
    return (
      <div ref={this.controls_root_ref} className={style.header}>
        <img className={style.logo} src={this.props.dark ? IconSVGW : IconSVG} alt="HiPlot" />
        {this.renderControls()}
        <ThemeToggle choice={this.props.themeChoice} onChange={this.props.onThemeChoice} />
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
