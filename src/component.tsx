/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import $ from "jquery";
import React from "react";
import * as _ from "underscore";

// Vendor CSS imports - PostCSS will scope these under .hip_thm--dark/.hip_thm--light
import "bootstrap/dist/css/bootstrap.min.css";
import "datatables.net-bs5/css/dataTables.bootstrap5.min.css";
import "./style/bs-dark.css";
import "./style/bs-light.css";
import "./style/fonts.css";
import "./style/global.css";
import "./style/menu.css";
import "./style/table.css";

import LogoSVG from "../hiplot/static/logo.svg";
import LogoSVGW from "../hiplot/static/logo-w.svg";
import { ContextMenu } from "./contextmenu";
import { type HiPlotDataControlProps, SelectedCountProgressBar } from "./controls";
import { StaticDataProvider } from "./dataproviders/static";
import { HiPlotDistributionPlugin } from "./distribution/plugin";
import { apply_filter, apply_filters, type Filter, FilterType, isFilter } from "./filters";
import { ErrorDisplay, HeaderBar } from "./header";
import style from "./hiplot.module.css";
import { infertypes, type ParamDef, type ParamDefMap } from "./infertypes";
import { ColorLegend } from "./legend";
import { setupBrowserCompat } from "./lib/browsercompat";
import {
  type ColorBinning,
  colorBinning,
  effectiveColorMap,
  NUMERIC_COLOR_MAPS,
} from "./lib/colors";
import { experimentRows } from "./lib/compress";
import { mounted } from "./lib/refs";
import {
  type PersistentState,
  PersistentStateInMemory,
  ReportingPersistentState,
  readState,
} from "./lib/savedstate";
import { storeThemeChoice, type ThemeChoice } from "./lib/theme";
import { type Toast, Toasts } from "./lib/toast";
import { ParallelPlot } from "./parallel/parallel";
import { ScatterPlots } from "./plots/scatterplots";
import type { DataProviderClass, HiPlotPluginData, PluginWindowState } from "./plugin";
import { RowsDisplayTable } from "./rowsdisplaytable";
import {
  type Datapoint,
  type DatapointLookup,
  type HiPlotExperiment,
  HiPlotLoadStatus,
  type IDatasets,
  type LoadURIPromise,
  type LoadURIPromiseResult,
  ParamType,
  PSTATE_COLOR_BY,
  PSTATE_COLOR_MAP,
  PSTATE_FILTERS,
  PSTATE_PARAMS,
} from "./types";

// Exported from HiPlot
export { ParallelPlot } from "./parallel/parallel";
export { PlotXY } from "./plotxy";
export type { HiPlotPluginData } from "./plugin";
export { RowsDisplayTable } from "./rowsdisplaytable";
export type { Datapoint, HiPlotExperiment, IDatasets } from "./types";
export { HiPlotLoadStatus } from "./types";

/** A display plugin: a component class rendered with the plugin data as props. */
export type PluginClass = React.ComponentClass<HiPlotPluginData>;
interface PluginsMap {
  [k: string]: PluginClass;
}

type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];
/** The props a plugin adds to HiPlotPluginData that are required, hence need a default. */
type PluginDefaults<P> = Omit<P, keyof HiPlotPluginData | OptionalKeys<P>>;

/**
 * Registers a plugin whose own props extend HiPlotPluginData. HiPlot only passes
 * HiPlotPluginData plus the experiment's display data, so every additional
 * required prop must come from `defaultProps`; the constraint enforces that,
 * which is what makes widening the class to PluginClass sound.
 */
export function definePlugin<P extends HiPlotPluginData>(
  cls: React.ComponentClass<P> & { defaultProps: PluginDefaults<P> },
): PluginClass {
  return cls as unknown as PluginClass;
}

class CanceledLoad extends Error {}

/** A crash this soon after a display was rebuilt means rebuilding does not help. */
const REBUILD_COOLDOWN_MS = 2000;

interface PluginBoundaryProps {
  name: string;
  notify: (message: string) => void;
  children: React.ReactNode;
}

interface PluginBoundaryState {
  /** Bumped to rebuild the display from its saved state. */
  generation: number;
  /** The error that stopped the display, while it is not rebuilt. */
  error: string | null;
}

/**
 * Keeps one display's crash from taking the page down: the display is rebuilt
 * from its saved state (which a display only updates once a change applied
 * cleanly), and the error is shown as a toast. A display that crashes again
 * right after being rebuilt shows its error in place instead.
 */
class PluginBoundary extends React.Component<PluginBoundaryProps, PluginBoundaryState> {
  state: PluginBoundaryState = { generation: 0, error: null };
  private lastRebuild = Number.NEGATIVE_INFINITY;
  static getDerivedStateFromError(error: unknown): Partial<PluginBoundaryState> {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const now = performance.now();
    if (now - this.lastRebuild < REBUILD_COOLDOWN_MS) {
      this.props.notify(`The ${this.props.name} display failed again and stays off: ${message}`);
      return;
    }
    this.lastRebuild = now;
    this.props.notify(`The ${this.props.name} display hit an error and was restored: ${message}`);
    this.setState((state) => ({ generation: state.generation + 1, error: null }));
  }
  render() {
    if (this.state.error !== null) {
      return (
        <div className="alert alert-danger" role="alert">
          The {this.props.name} display could not be drawn: {this.state.error}
        </div>
      );
    }
    return <React.Fragment key={this.state.generation}>{this.props.children}</React.Fragment>;
  }
}

type PluginProps = HiPlotPluginData &
  React.RefAttributes<React.Component<HiPlotPluginData>> & {
    onHiddenColumnsChange?: (count: number) => void;
  };

// Makes a Promise cancelable
interface CancelablePromise {
  promise: LoadURIPromise;
  cancel: () => void;
}
const makeCancelable = (promise: LoadURIPromise): CancelablePromise => {
  let hasCanceled_ = false;

  const wrappedPromise = new Promise<LoadURIPromiseResult>((resolve, reject) => {
    promise.then(
      (val) => (hasCanceled_ ? reject(new CanceledLoad()) : resolve(val)),
      (error: unknown) => (hasCanceled_ ? reject(new CanceledLoad()) : reject(error)),
    );
  });

  return {
    promise: wrappedPromise,
    cancel() {
      hasCanceled_ = true;
    },
  };
};

// BEGIN_HIPLOT_PROPS
export type HiPlotDarkMode = boolean | "auto";

export interface HiPlotProps {
  // Experiment to be displayed. Can be created with `hip.Experiment.from_iterable`
  experiment: HiPlotExperiment | null;
  // Display plugins (by default parallel plot, plotxy, distribution and table)
  plugins: PluginsMap;
  // An object where we can persist changes
  // If not provided, will create a `PersistentStateInMemory` object
  persistentState?: PersistentState | null;
  // Callbacks when selection changes, filtering, or brush extents change
  onChange: { [k: string]: (type: string, data: unknown) => void } | null;
  // Enable dark-mode. Use "auto" to follow system / JupyterLab theme.
  dark: HiPlotDarkMode;
  // Adds extra assertions (disabled by default)
  asserts: boolean;
  /* A class that can be used to dynamically fetch experiments
    Examples:
    - WebserverDataProvider: textarea to input URI, fetches experiments from server
    - UploadDataProvider: upload CSV files in your browser
    */
  dataProvider: DataProviderClass | null;
}
// END_HIPLOT_PROPS

interface HiPlotState extends IDatasets {
  experiment: HiPlotExperiment | null;
  loadStatus: HiPlotLoadStatus;
  loadPromise: CancelablePromise | null;
  error: string | null;
  params_def: ParamDefMap;
  params_def_unfiltered: ParamDefMap;
  dp_lookup: DatapointLookup;
  colorby: string | null;
  colormap: string | null;
  /** The numeric color map picked in the legend; null until one is. */
  pickedColorMap: string | null;

  rows_filtered_filters: Array<Filter>; // `rows_all` -> `rows_filtered`
  rows_selected_filter: Filter | null; // `rows_filtered` -> `rows_selected`

  // Data that persists upon page reload, sharing link etc...
  persistentState: PersistentState;
  dark: boolean;
  darkModeSetting: HiPlotDarkMode;
  dataProvider: DataProviderClass;

  // Track hidden columns count for header button
  restorableColumnsCount: number;
  toasts: Toast[];
}

function detectIsDarkTheme(): boolean {
  const htmlThemeOverride = getHtmlThemeOverride();
  if (htmlThemeOverride !== null) {
    return htmlThemeOverride;
  }
  // Hack: detect dark/light theme in Jupyter Lab
  const jupyterLabAttrLightTheme = "data-jp-theme-light";
  if (typeof document !== "undefined" && document.body?.hasAttribute(jupyterLabAttrLightTheme)) {
    return document.body.getAttribute(jupyterLabAttrLightTheme) === "false";
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return false;
}

function getHtmlThemeOverride(): boolean | null {
  if (typeof document === "undefined") {
    return null;
  }
  const html = document.documentElement;
  if (!html) {
    return null;
  }
  const theme = html.getAttribute("data-theme");
  if (theme === "dark") {
    return true;
  }
  if (theme === "light") {
    return false;
  }
  return null;
}

export function normalizeDarkModeSetting(
  value: unknown,
  fallback: HiPlotDarkMode = "auto",
): HiPlotDarkMode {
  if (value === "auto") {
    return "auto";
  }
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "auto" || normalized === "system") {
      return "auto";
    }
    if (["true", "1", "yes", "on", "dark"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off", "light"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

const isNumericColorMap = (value: unknown): value is string =>
  NUMERIC_COLOR_MAPS.some((map) => map.id === value);

function themeChoiceOf(setting: HiPlotDarkMode): ThemeChoice {
  if (setting === "auto") {
    return "system";
  }
  return setting ? "dark" : "light";
}

function resolveDarkModeSetting(setting: HiPlotDarkMode): boolean {
  return setting === "auto" ? detectIsDarkTheme() : setting;
}

export enum DefaultPlugins {
  // Names correspond to values of (python) hip.Displays
  PARALLEL_PLOT = "PARALLEL_PLOT",
  XY = "XY",
  DISTRIBUTION = "DISTRIBUTION",
  TABLE = "TABLE",
}

export const defaultPlugins: PluginsMap = {
  [DefaultPlugins.PARALLEL_PLOT]: definePlugin(ParallelPlot),
  [DefaultPlugins.XY]: definePlugin(ScatterPlots),
  [DefaultPlugins.DISTRIBUTION]: definePlugin(HiPlotDistributionPlugin),
  [DefaultPlugins.TABLE]: definePlugin(RowsDisplayTable),
};

export function createDefaultPlugins(): PluginsMap {
  return Object.assign({}, defaultPlugins);
}

export class HiPlot extends React.Component<HiPlotProps, HiPlotState> {
  // React refs
  contextMenuRef = React.createRef<ContextMenu>();
  rootRef = React.createRef<HTMLDivElement>();

  plugins_window_state: { [plugin: string]: PluginWindowState } = {};

  // For debugging/tests
  plugins_ref: { [plugin: string]: React.RefObject<React.Component<HiPlotPluginData> | null> } = {};
  mediaQueryList: MediaQueryList | null = null;
  mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null;
  jupyterThemeObserver: MutationObserver | null = null;
  htmlThemeObserver: MutationObserver | null = null;

  constructor(props: HiPlotProps) {
    super(props);
    const darkModeSetting = normalizeDarkModeSetting(this.props.dark, "auto");
    const persistentState = new ReportingPersistentState(
      props.persistentState ?? new PersistentStateInMemory("", {}),
      (key, value) =>
        this.notify(
          `The saved setting "${key}" (${JSON.stringify(value)}) does not fit this page; its default is used.`,
        ),
    );
    this.state = {
      experiment: null,
      colormap: null,
      pickedColorMap: readState(persistentState, PSTATE_COLOR_MAP, isNumericColorMap, null),
      loadStatus: HiPlotLoadStatus.None,
      loadPromise: null,
      error: null,
      dp_lookup: {},
      rows_all_unfiltered: [],
      rows_filtered: [],
      rows_filtered_filters: [],
      rows_selected: [],
      rows_selected_filter: null,
      rows_highlighted: [],
      params_def: {},
      params_def_unfiltered: {},
      colorby: null,
      dark: resolveDarkModeSetting(darkModeSetting),
      darkModeSetting,
      persistentState,
      dataProvider: this.props.dataProvider ? this.props.dataProvider : StaticDataProvider,
      restorableColumnsCount: 0,
      toasts: [],
    };
    Object.keys(props.plugins).forEach((name, _index) => {
      this.plugins_window_state[name] = {};
      this.plugins_ref[name] = React.createRef<React.Component<HiPlotPluginData>>();
    });
  }
  static defaultProps = {
    loadURI: null,
    comm: null,
    dark: "auto",
    asserts: false,
    plugins: defaultPlugins,
    experiment: null,
    dataProvider: null,
    onChange: null,
  };
  applyDarkModeSetting(nextSettingRaw: unknown): void {
    const nextSetting = normalizeDarkModeSetting(nextSettingRaw, this.state.darkModeSetting);
    if (nextSetting !== this.state.darkModeSetting) {
      if (nextSetting === "auto") {
        this.startAutoThemeListeners();
      } else {
        this.stopAutoThemeListeners();
      }
    }
    const nextDark = resolveDarkModeSetting(nextSetting);
    if (nextSetting !== this.state.darkModeSetting || nextDark !== this.state.dark) {
      this.setState({
        darkModeSetting: nextSetting,
        dark: nextDark,
      });
    }
  }
  private nextToastId = 0;
  /**
   * Shows `message` as a toast. Deferred, as it may be called while a display
   * renders (when it reads unusable saved state); repeats of a shown message
   * are dropped.
   */
  notify = (message: string): void => {
    window.setTimeout(() => {
      this.setState((state) =>
        state.toasts.some((toast) => toast.message === message)
          ? null
          : { toasts: [...state.toasts, { id: this.nextToastId++, message }] },
      );
    }, 0);
  };
  dismissToast = (id: number): void => {
    this.setState((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  };
  /** The theme picked with the header toggle: applied, and remembered for next time. */
  onThemeChoice = (choice: ThemeChoice): void => {
    storeThemeChoice(choice);
    this.applyDarkModeSetting(choice);
  };
  startAutoThemeListeners(): void {
    if (this.mediaQueryList === null && typeof window !== "undefined" && window.matchMedia) {
      this.mediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");
      this.mediaQueryListener = (event: MediaQueryListEvent) => {
        if (this.state.darkModeSetting === "auto") {
          this.setState({ dark: event.matches });
        }
      };
      this.mediaQueryList.addEventListener("change", this.mediaQueryListener);
    }
    if (this.jupyterThemeObserver === null && typeof document !== "undefined" && document.body) {
      this.jupyterThemeObserver = new MutationObserver(() => {
        if (this.state.darkModeSetting === "auto") {
          const nextDark = detectIsDarkTheme();
          if (nextDark !== this.state.dark) {
            this.setState({ dark: nextDark });
          }
        }
      });
      this.jupyterThemeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ["data-jp-theme-light"],
      });
    }
    if (
      this.htmlThemeObserver === null &&
      typeof document !== "undefined" &&
      document.documentElement
    ) {
      this.htmlThemeObserver = new MutationObserver(() => {
        if (this.state.darkModeSetting === "auto") {
          const nextDark = detectIsDarkTheme();
          if (nextDark !== this.state.dark) {
            this.setState({ dark: nextDark });
          }
        }
      });
      this.htmlThemeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    }
  }
  stopAutoThemeListeners(): void {
    if (this.mediaQueryList && this.mediaQueryListener) {
      this.mediaQueryList.removeEventListener("change", this.mediaQueryListener);
    }
    this.mediaQueryList = null;
    this.mediaQueryListener = null;
    if (this.jupyterThemeObserver) {
      this.jupyterThemeObserver.disconnect();
      this.jupyterThemeObserver = null;
    }
    if (this.htmlThemeObserver) {
      this.htmlThemeObserver.disconnect();
      this.htmlThemeObserver = null;
    }
  }
  static getDerivedStateFromError(error: Error) {
    // Update state so the next render will show the fallback UI.
    return {
      experiment: null,
      loadStatus: HiPlotLoadStatus.Error,
      error: error.toString(),
    };
  }
  makeDatasets(
    rows_all_unfiltered: Datapoint[],
    dp_lookup: DatapointLookup,
    initial_filters: Array<Filter>,
  ): IDatasets {
    for (const row of rows_all_unfiltered) {
      dp_lookup[row.uid] = row;
    }
    let rows_filtered =
      initial_filters.length === 0
        ? rows_all_unfiltered
        : apply_filters(rows_all_unfiltered, initial_filters);
    if (!rows_filtered.length) {
      // Filters saved against another dataset would hide everything: start unfiltered.
      rows_filtered = rows_all_unfiltered;
    }
    return {
      rows_all_unfiltered: rows_all_unfiltered,
      rows_filtered: rows_filtered,
      rows_selected: rows_filtered,
      rows_highlighted: [],
    };
  }
  sendMessage(type: string, get_data: () => unknown): void {
    const callback = this.props.onChange?.[type];
    if (callback !== undefined) {
      callback(type, get_data());
    }
  }
  callSelectedUidsHooks = _.debounce((): void => {
    this.sendMessage("selected_uids", () => this.state.rows_selected.map((row) => `${row.uid}`));
  }, 200);
  callFilteredUidsHooks = _.debounce((): void => {
    this.sendMessage("filtered_uids", () => this.state.rows_filtered.map((row) => `${row.uid}`));
  }, 200);
  _loadExperiment(experiment: HiPlotExperiment) {
    // Generate dataset for Parallel Plot
    const dp_lookup: DatapointLookup = {};
    const persistedFilters = this.state.persistentState.get(PSTATE_FILTERS);
    let initFilters =
      Array.isArray(persistedFilters) && persistedFilters.every(isFilter) ? persistedFilters : [];
    const datasets = this.makeDatasets(experimentRows(experiment), dp_lookup, initFilters);
    if (datasets.rows_all_unfiltered === datasets.rows_filtered) {
      initFilters = [];
    }
    const params_def = infertypes(
      this.state.persistentState.children(PSTATE_PARAMS),
      datasets.rows_filtered,
      experiment.parameters_definition,
    );
    const params_def_unfiltered =
      datasets.rows_filtered === datasets.rows_all_unfiltered
        ? params_def
        : infertypes(
            this.state.persistentState.children(PSTATE_PARAMS),
            datasets.rows_all_unfiltered,
            experiment.parameters_definition,
          );

    // Color handling
    function get_default_color(): string {
      if (experiment.colorby && params_def[experiment.colorby]) {
        return experiment.colorby;
      }
      function select_as_coloring_score(r: string): number {
        const pd = params_def[r];
        let score = 0;
        if (pd.colors || pd.colormap) {
          score += 100;
        }
        if (pd.type === ParamType.CATEGORICAL) {
          score -= 20;
        }
        if (pd.optional) {
          score -= 40;
        }
        return score;
      }
      const possibles = Object.keys(params_def).sort(
        (a, b) => select_as_coloring_score(b) - select_as_coloring_score(a),
      );
      return possibles[0];
    }
    const persistedColorby = this.state.persistentState.get(PSTATE_COLOR_BY);
    const colorby =
      typeof persistedColorby === "string" && params_def[persistedColorby] !== undefined
        ? persistedColorby
        : get_default_color();
    this.setState({
      experiment: experiment,
      colormap: experiment.colormap ?? null,
      loadStatus: HiPlotLoadStatus.Loaded,
      dp_lookup: dp_lookup,
      colorby: colorby,
      params_def: params_def,
      params_def_unfiltered: params_def_unfiltered,
      rows_filtered_filters: initFilters,
      ...datasets,
    });
  }
  private cachedColorBinning: {
    pd: ParamDef;
    colormap: string | null;
    pickedColorMap: string | null;
    dark: boolean;
    binning: ColorBinning;
  } | null = null;
  /** Color bins of the color-by column, rebuilt only when it or the color map changes. */
  colorBinning(): ColorBinning {
    const colorby = this.state.colorby;
    if (colorby === null) {
      throw new Error("Rows are only colored once an experiment is loaded");
    }
    const pd = this.state.params_def[colorby];
    const { colormap, pickedColorMap, dark } = this.state;
    const cached = this.cachedColorBinning;
    if (
      cached !== null &&
      cached.pd === pd &&
      cached.colormap === colormap &&
      cached.pickedColorMap === pickedColorMap &&
      cached.dark === dark
    ) {
      return cached.binning;
    }
    const binning = colorBinning(pd, colormap, dark ? "dark" : "light", pickedColorMap);
    this.cachedColorBinning = { pd, colormap, pickedColorMap, dark, binning };
    return binning;
  }
  /** A numeric color map picked in the legend, remembered with the page state. */
  onPickColorMap = (id: string): void => {
    this.setState({ pickedColorMap: id });
    this.state.persistentState.set(PSTATE_COLOR_MAP, id);
  };
  getColorForRow(trial: Datapoint, alpha: number): string {
    const colorby = this.state.colorby;
    if (colorby === null) {
      throw new Error("Rows are only colored once an experiment is loaded");
    }
    const binning = this.colorBinning();
    return binning.css(binning.binOf(trial[colorby]), alpha);
  }
  loadWithPromise(prom: LoadURIPromise) {
    this.setState({
      loadStatus: HiPlotLoadStatus.Loading,
      loadPromise: makeCancelable(prom),
    });
  }
  componentWillUnmount() {
    this.stopAutoThemeListeners();
    if (this.contextMenuRef.current) {
      this.contextMenuRef.current.removeCallbacks(this);
    }
    if (this.state.loadPromise) {
      this.state.loadPromise.cancel();
    }
    this.callSelectedUidsHooks.cancel();
    this.callFilteredUidsHooks.cancel();
  }
  componentDidMount() {
    setupBrowserCompat(mounted(this.rootRef));
    if (this.state.darkModeSetting === "auto") {
      this.startAutoThemeListeners();
    }

    // Setup contextmenu when we right-click a parameter
    const contextMenu = mounted(this.contextMenuRef);
    contextMenu.addCallback(this.columnContextMenu.bind(this), this);
    contextMenu.addCallback(this.columnContextMenuFooter.bind(this), this, "last");

    // Load experiment provided in constructor if any
    if (this.props.experiment) {
      this.loadWithPromise(Promise.resolve({ experiment: this.props.experiment }));
    }
  }
  componentDidUpdate(prevProps: HiPlotProps, prevState: HiPlotState): void {
    if (prevProps.dark !== this.props.dark) {
      this.applyDarkModeSetting(this.props.dark);
    }
    if (prevState.rows_filtered_filters !== this.state.rows_filtered_filters) {
      this.state.persistentState.set(PSTATE_FILTERS, this.state.rows_filtered_filters);
    }
    if (prevState.colorby !== this.state.colorby && this.state.colorby) {
      this.state.persistentState.set(PSTATE_COLOR_BY, this.state.colorby);
    }
    if (this.state.loadStatus !== HiPlotLoadStatus.Loading) {
      if (
        this.props.experiment !== null &&
        ((this.state.loadStatus === HiPlotLoadStatus.Error &&
          this.props.experiment !== prevProps.experiment) ||
          (this.state.loadStatus !== HiPlotLoadStatus.Error &&
            this.props.experiment !== this.state.experiment))
      ) {
        this.loadWithPromise(Promise.resolve({ experiment: this.props.experiment }));
      } else {
        if (prevState.rows_selected !== this.state.rows_selected) {
          this.callSelectedUidsHooks();
        }
        if (prevState.rows_filtered !== this.state.rows_filtered) {
          this.callFilteredUidsHooks();
        }
      }
    }
    if (
      this.state.loadStatus === HiPlotLoadStatus.Loading &&
      this.state.loadPromise !== null &&
      this.state.loadPromise !== prevState.loadPromise
    ) {
      const prom = this.state.loadPromise.promise;
      prom
        .then((data) => {
          if ("error" in data) {
            console.log("Experiment loading failed", data);
            this.setState({
              loadStatus: HiPlotLoadStatus.Error,
              experiment: null,
              error: data.error,
            });
            return;
          }
          this._loadExperiment(data.experiment);
        })
        .catch((error: unknown) => {
          if (error instanceof CanceledLoad) {
            return;
          }
          console.log("Error", error);
          this.setState({
            loadStatus: HiPlotLoadStatus.Error,
            experiment: null,
            error: "HTTP error, check server logs / javascript console",
          });
          throw error;
        });
    }
  }
  columnContextMenu(column: string, cm: HTMLDivElement) {
    const VAR_TYPE_TO_NAME = {
      [ParamType.CATEGORICAL]: "Categorical",
      [ParamType.NUMERIC]: "Number",
      [ParamType.NUMERICLOG]: "Number (log-scale)",
      [ParamType.NUMERICPERCENTILE]: "Number (percentile-scale)",
      [ParamType.TIMESTAMP]: "Timestamp",
    };

    const contextmenu = $(cm);
    contextmenu.append($('<h6 class="dropdown-header">Data scaling</h6>'));
    this.state.params_def[column].type_options.forEach((possible_type) => {
      const option = $('<a class="dropdown-item" href="#">').text(VAR_TYPE_TO_NAME[possible_type]);
      if (possible_type === this.state.params_def[column].type) {
        option.addClass("disabled").css("pointer-events", "none");
      }
      option.on("click", (event) => {
        contextmenu.css("display", "none");
        this.setState((state) => ({
          params_def: {
            ...state.params_def,
            [column]: {
              ...state.params_def[column],
              type: possible_type,
            },
          },
        }));
        this.state.persistentState
          .children(PSTATE_PARAMS)
          .children(column)
          .set("type", possible_type);
        event.preventDefault();
      });
      contextmenu.append(option);
    });
    contextmenu.append($('<div class="dropdown-divider"></div>'));

    const pp = this.parallelPlot();
    if (pp !== null) {
      const invert_axis = $('<a class="dropdown-item" href="#">Invert axis</a>');
      invert_axis.on("click", (event) => {
        const extent = pp.toggleInvertAxis(column);
        pp.update_ticks(column, extent);
        event.preventDefault();
      });
      contextmenu.append(invert_axis);
    }

    // Color by
    const link_colorize = $('<a class="dropdown-item" href="#">Use for coloring</a>');
    link_colorize.on("click", (event) => {
      this.setState({
        colorby: column,
      });
      event.preventDefault();
    });
    if (this.state.colorby === column) {
      link_colorize.addClass("disabled").css("pointer-events", "none");
    }
    contextmenu.append(link_colorize);
  }
  columnContextMenuFooter(column: string, cm: HTMLDivElement) {
    const contextmenu = $(cm);
    const pp = this.parallelPlot();
    contextmenu.append($('<div class="dropdown-divider"></div>'));

    if (pp?.can_hide_axis(column)) {
      const hide_axis = $('<a class="dropdown-item" href="#">Hide axis</a>');
      hide_axis.on("click", (event) => {
        pp.remove_axis(column);
        event.preventDefault();
      });
      contextmenu.append(hide_axis);
    }

    const close_menu = $('<a class="dropdown-item" href="#">Close menu</a>');
    close_menu.on("click", (event) => {
      mounted(this.contextMenuRef).hide();
      event.preventDefault();
    });
    contextmenu.append(close_menu);
  }
  /** The mounted parallel plot, if this HiPlot displays one. */
  parallelPlot(): ParallelPlot | null {
    const current = this.plugins_ref[DefaultPlugins.PARALLEL_PLOT]?.current;
    return current instanceof ParallelPlot ? current : null;
  }
  createNewParamsDef(rows_filtered: Array<Datapoint>): ParamDefMap {
    const new_pd = Object.assign({}, this.state.params_def);
    Object.assign(
      new_pd,
      infertypes(
        this.state.persistentState.children(PSTATE_PARAMS),
        rows_filtered,
        this.state.params_def,
      ),
    );
    return new_pd;
  }
  restoreAllRows(): void {
    /**
     * When we hit `Restore` button
     */
    this.setState((state) => {
      const all_rows = state.rows_all_unfiltered;
      return {
        rows_selected: all_rows,
        rows_selected_filter: null,
        rows_filtered: all_rows,
        rows_filtered_filters: [],
        params_def: this.createNewParamsDef(all_rows),
      };
    });
  }
  filterRows(keep: boolean): void {
    /**
     * When we hit Keep (keep=true), or Exclude (keep=false) buttons
     */
    this.setState((state) => {
      const new_filtered = keep
        ? state.rows_selected
        : _.difference(state.rows_filtered, state.rows_selected);
      const selection = state.rows_selected_filter;
      // A selection that no filter describes still filters the rows; it just cannot be
      // replayed from the saved state.
      const applied: Filter[] =
        selection === null ? [] : [keep ? selection : { type: FilterType.Not, data: selection }];
      return {
        rows_filtered: new_filtered,
        params_def: this.createNewParamsDef(new_filtered),
        rows_selected_filter: null,
        rows_filtered_filters: state.rows_filtered_filters.concat(applied),
      };
    });
  }
  setSelected(rows: Array<Datapoint>, filter: Filter | null = null): void {
    if (filter && _.isEqual(filter, this.state.rows_selected_filter)) {
      return;
    }
    if (filter && this.props.asserts) {
      const new_rows = apply_filter(this.state.rows_filtered, filter);
      if (new_rows.length !== rows.length || _.difference(new_rows, rows).length) {
        console.error(
          "Warning! Filter ",
          filter,
          " does not match given rows",
          rows,
          " Computed rows with filter:",
          new_rows,
        );
      }
    }
    this.setState({
      rows_selected: rows,
      rows_selected_filter: filter,
    });
  }
  setHighlighted(rows: Array<Datapoint>): void {
    this.setState({ rows_highlighted: rows });
  }
  renderRowText(row: Datapoint): string {
    return row.uid;
  }
  render() {
    const datasets: IDatasets = {
      rows_all_unfiltered: this.state.rows_all_unfiltered,
      rows_filtered: this.state.rows_filtered,
      rows_highlighted: this.state.rows_highlighted,
      rows_selected: this.state.rows_selected,
    };
    const controlProps: HiPlotDataControlProps = {
      restoreAllRows: this.restoreAllRows.bind(this),
      filterRows: this.filterRows.bind(this),
      ...datasets,
    };
    const createPluginProps = (experiment: HiPlotExperiment, name: string): PluginProps => {
      const colorby = this.state.colorby;
      if (colorby === null) {
        throw new Error("A loaded experiment always has a color-by column");
      }
      const baseProps: PluginProps = {
        ref: this.plugins_ref[name],
        ...experiment.display_data?.[name],
        ...datasets,
        rows_selected_filter: this.state.rows_selected_filter,
        name: name,
        persistentState: this.state.persistentState.children(name),
        window_state: this.plugins_window_state[name],
        sendMessage: this.sendMessage.bind(this),
        get_color_for_row: this.getColorForRow.bind(this),
        color_binning: this.colorBinning(),
        dark: this.state.dark,
        experiment,
        params_def: this.state.params_def,
        params_def_unfiltered: this.state.params_def_unfiltered,
        dp_lookup: this.state.dp_lookup,
        colorby,
        render_row_text: this.renderRowText.bind(this),
        context_menu_ref: this.contextMenuRef,
        setSelected: this.setSelected.bind(this),
        setHighlighted: this.setHighlighted.bind(this),
        notify: this.notify,
        asserts: this.props.asserts,
      };
      // Add callback for ParallelPlot to notify when hidden columns change
      if (name === DefaultPlugins.PARALLEL_PLOT) {
        baseProps.onHiddenColumnsChange = this.onHiddenColumnsChange.bind(this);
      }
      return baseProps;
    };
    const experiment = this.state.experiment;
    return (
      <div ref={this.rootRef} className={`hip_thm--${this.state.dark ? "dark" : "light"}`}>
        <div className={style.hiplot}>
          <SelectedCountProgressBar {...controlProps} />
          <HeaderBar
            weightColumn={this.state.experiment ? this.state.experiment.weightcolumn : undefined}
            onLoadExperiment={this.loadWithPromise.bind(this)}
            persistentState={this.state.persistentState}
            dataProvider={this.state.dataProvider}
            loadStatus={this.state.loadStatus}
            dark={this.state.dark}
            themeChoice={themeChoiceOf(this.state.darkModeSetting)}
            onThemeChoice={this.onThemeChoice}
            restorableColumnsCount={this.state.restorableColumnsCount}
            onRestoreColumns={this.restoreAllColumns.bind(this)}
            {...controlProps}
          />
          {this.state.loadStatus === HiPlotLoadStatus.Error && this.state.error !== null && (
            <ErrorDisplay error={this.state.error} />
          )}
          {this.state.loadStatus !== HiPlotLoadStatus.Loaded && (
            <DocAndCredits dark={this.state.dark} />
          )}
          {this.state.loadStatus === HiPlotLoadStatus.Loaded && this.state.colorby !== null && (
            <ColorLegend
              binning={this.colorBinning()}
              column={this.state.colorby}
              labelHtml={this.state.params_def[this.state.colorby].label_html}
              colorMap={effectiveColorMap(
                this.state.params_def[this.state.colorby],
                this.state.colormap,
                this.state.pickedColorMap,
              )}
              theme={this.state.dark ? "dark" : "light"}
              onPickColorMap={this.onPickColorMap}
            />
          )}
          <ContextMenu ref={this.contextMenuRef} />
          <Toasts toasts={this.state.toasts} onDismiss={this.dismissToast} />
          {this.state.loadStatus === HiPlotLoadStatus.Loaded && experiment !== null && (
            <div>
              {(experiment.enabled_displays ?? Object.keys(this.props.plugins)).map(
                (display_name: string) => (
                  <PluginBoundary key={display_name} name={display_name} notify={this.notify}>
                    {React.createElement(
                      this.props.plugins[display_name],
                      createPluginProps(experiment, display_name),
                    )}
                  </PluginBoundary>
                ),
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
  /** The mounted instance of a plugin class. */
  getPlugin<T extends React.Component<HiPlotPluginData>>(
    cls: abstract new (...args: never[]) => T,
  ): T {
    for (const ref of Object.values(this.plugins_ref)) {
      if (ref.current instanceof cls) {
        return ref.current;
      }
    }
    throw new Error(`Can not find plugin ${cls.name}`);
  }
  onHiddenColumnsChange(count: number): void {
    if (count !== this.state.restorableColumnsCount) {
      this.setState({ restorableColumnsCount: count });
    }
  }
  getRestorableColumnsCount(): number {
    return this.parallelPlot()?.getRestorableColumnsCount() ?? 0;
  }
  restoreAllColumns(): void {
    this.parallelPlot()?.restore_all_columns();
  }
}

interface DocsCreditsProps {
  dark: boolean;
}

class DocAndCredits extends React.Component<DocsCreditsProps> {
  render() {
    return (
      <div className="container hide-when-loaded">
        <div className="row">
          <div className="col-md-3"></div>
          <div className="col-md-6">
            <img src={this.props.dark ? LogoSVGW : LogoSVG} alt="HiPlot" />
          </div>
          <div className="col-md-3"></div>
          <div className="col-md-6">
            <h3>Controls</h3>
            <p>
              <strong>Brush</strong>: Drag vertically along an axis.
              <br />
              <strong>Remove Brush</strong>: Tap the axis background.
              <br />
              <strong>Reorder Axes</strong>: Drag a label horizontally.
              <br />
              <strong>Invert Axis</strong>: Click an axis label (desktop) or use the label menu
              (mobile).
              <br />
              <strong>Remove Axis</strong>: Drag axis label to the left edge.
              <br />
            </p>
          </div>
          <div className="cold-md-6">
            <h3>Credits &amp; License</h3>
            <p>
              Adapted from examples by
              <br />
              <a href="http://bl.ocks.org/syntagmatic/3150059">Kai</a>,{" "}
              <a href="http://bl.ocks.org/1341021">Mike Bostock</a> and{" "}
              <a href="http://bl.ocks.org/1341281">Jason Davies</a>
              <br />
            </p>
            <p>
              Released under the <strong>MIT License</strong>.
            </p>
          </div>
        </div>
      </div>
    );
  }
}
