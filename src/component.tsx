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
import "./style/global.css";

import LogoSVG from "../hiplot/static/logo.svg";
import LogoSVGW from "../hiplot/static/logo-w.svg";
import { ContextMenu } from "./contextmenu";
import { type HiPlotDataControlProps, SelectedCountProgressBar } from "./controls";
import { StaticDataProvider } from "./dataproviders/static";
import { HiPlotDistributionPlugin } from "./distribution/plugin";
import { apply_filter, apply_filters, type Filter, FilterType } from "./filters";
import { ErrorDisplay, HeaderBar } from "./header";
import style from "./hiplot.module.css";
import { colorScheme, infertypes, type ParamDefMap } from "./infertypes";
import { setupBrowserCompat } from "./lib/browsercompat";
import { uncompress } from "./lib/compress";
import { type PersistentState, PersistentStateInMemory } from "./lib/savedstate";
import { ParallelPlot } from "./parallel/parallel";
import { PlotXY } from "./plotxy";
import type { DataProviderClass, HiPlotPluginData } from "./plugin";
import { RowsDisplayTable } from "./rowsdisplaytable";
import {
  type Datapoint,
  type DatapointLookup,
  type HiPlotExperiment,
  HiPlotLoadStatus,
  type IDatasets,
  ParamType,
  PSTATE_COLOR_BY,
  PSTATE_FILTERS,
  PSTATE_PARAMS,
} from "./types";

export { ParallelPlot } from "./parallel/parallel";
// Exported from HiPlot
export { PlotXY } from "./plotxy";
export type { HiPlotPluginData } from "./plugin";
export { RowsDisplayTable } from "./rowsdisplaytable";
export type { Datapoint, HiPlotExperiment, IDatasets } from "./types";
export { HiPlotLoadStatus } from "./types";

type PluginComponent<P> = React.Component<P, any>;
type PluginComponentClass<P> = React.ComponentClass<P>;
type PluginClass = React.ClassType<
  HiPlotPluginData,
  PluginComponent<HiPlotPluginData>,
  PluginComponentClass<HiPlotPluginData>
>;
interface PluginsMap {
  [k: string]: PluginClass;
}

type LoadURIPromiseResult = { experiment: HiPlotExperiment } | { error: string };
export type LoadURIPromise = Promise<LoadURIPromiseResult>;

// Makes a Promise cancelable
interface CancelablePromise {
  promise: LoadURIPromise;
  cancel: () => void;
}
const makeCancelable = (promise: LoadURIPromise): CancelablePromise => {
  let hasCanceled_ = false;

  const wrappedPromise = new Promise((resolve: (r: LoadURIPromiseResult) => void, reject) => {
    promise.then(
      (val) => (hasCanceled_ ? reject({ isCanceled: true }) : resolve(val)),
      (error) => (hasCanceled_ ? reject({ isCanceled: true }) : reject(error)),
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
  persistentState?: PersistentState;
  // Callbacks when selection changes, filtering, or brush extents change
  onChange: { [k: string]: (type: string, data: any) => void };
  // Enable dark-mode. Use "auto" to follow system / JupyterLab theme.
  dark: HiPlotDarkMode;
  // Adds extra assertions (disabled by default)
  asserts: boolean;
  /* A class that can be used to dynamically fetch experiments
    Examples:
    - WebserverDataProvider: textarea to input URI, fetches experiments from server
    - UploadDataProvider: upload CSV files in your browser
    */
  dataProvider: DataProviderClass;
}
// END_HIPLOT_PROPS

interface HiPlotState extends IDatasets {
  experiment: HiPlotExperiment | null;
  loadStatus: HiPlotLoadStatus;
  loadPromise: CancelablePromise | null;
  error: string;
  params_def: ParamDefMap;
  params_def_unfiltered: ParamDefMap;
  dp_lookup: DatapointLookup;
  colorby: string;
  colormap: string;

  rows_filtered_filters: Array<Filter>; // `rows_all` -> `rows_filtered`
  rows_selected_filter: Filter; // `rows_filtered` -> `rows_selected`

  // Data that persists upon page reload, sharing link etc...
  persistentState: PersistentState;
  dark: boolean;
  darkModeSetting: HiPlotDarkMode;
  dataProvider: DataProviderClass;

  // Track hidden columns count for header button
  restorableColumnsCount: number;
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
  // @ts-expect-error
  [DefaultPlugins.PARALLEL_PLOT]: ParallelPlot,
  // @ts-expect-error
  [DefaultPlugins.XY]: PlotXY,
  // @ts-expect-error
  [DefaultPlugins.DISTRIBUTION]: HiPlotDistributionPlugin,
  // @ts-expect-error
  [DefaultPlugins.TABLE]: RowsDisplayTable,
};

export function createDefaultPlugins(): PluginsMap {
  return Object.assign({}, defaultPlugins);
}

export class HiPlot extends React.Component<HiPlotProps, HiPlotState> {
  // React refs
  contextMenuRef = React.createRef<ContextMenu>();
  rootRef = React.createRef<HTMLDivElement>();

  plugins_window_state: { [plugin: string]: any } = {};

  plugins_ref: { [plugin: string]: React.RefObject<PluginClass> } = {}; // For debugging/tests
  mediaQueryList: MediaQueryList | null = null;
  mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null;
  jupyterThemeObserver: MutationObserver | null = null;
  htmlThemeObserver: MutationObserver | null = null;

  constructor(props: HiPlotProps) {
    super(props);
    const darkModeSetting = normalizeDarkModeSetting(this.props.dark, "auto");
    this.state = {
      experiment: null,
      colormap: null,
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
      persistentState:
        props.persistentState !== undefined && props.persistentState !== null
          ? props.persistentState
          : new PersistentStateInMemory("", {}),
      dataProvider: this.props.dataProvider ? this.props.dataProvider : StaticDataProvider,
      restorableColumnsCount: 0,
    };
    Object.keys(props.plugins).forEach((name, _index) => {
      this.plugins_window_state[name] = {};
      this.plugins_ref[name] = React.createRef<PluginClass>();
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
  startAutoThemeListeners(): void {
    if (this.mediaQueryList === null && typeof window !== "undefined" && window.matchMedia) {
      this.mediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");
      this.mediaQueryListener = (event: MediaQueryListEvent) => {
        if (this.state.darkModeSetting === "auto") {
          this.setState({ dark: event.matches });
        }
      };
      if (this.mediaQueryList.addEventListener) {
        this.mediaQueryList.addEventListener("change", this.mediaQueryListener);
      } else if ((this.mediaQueryList as any).addListener) {
        (this.mediaQueryList as any).addListener(this.mediaQueryListener);
      }
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
      if (this.mediaQueryList.removeEventListener) {
        this.mediaQueryList.removeEventListener("change", this.mediaQueryListener);
      } else if ((this.mediaQueryList as any).removeListener) {
        (this.mediaQueryList as any).removeListener(this.mediaQueryListener);
      }
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
    experiment: HiPlotExperiment | null,
    dp_lookup: DatapointLookup,
    initial_filters: Array<Filter>,
  ): IDatasets {
    if (experiment) {
      const rows_all_unfiltered = experiment.datapoints.map((t) => {
        const obj_with_uid = $.extend(
          {
            uid: t.uid,
            from_uid: t.from_uid,
          },
          t.values,
        );
        dp_lookup[t.uid] = obj_with_uid;
        return obj_with_uid;
      });
      let rows_filtered = rows_all_unfiltered;
      try {
        rows_filtered = apply_filters(rows_all_unfiltered, initial_filters);
        if (!rows_filtered.length) {
          rows_filtered = rows_all_unfiltered;
          console.log("Not reapplying filters (would filter out all rows)");
        }
      } catch (err) {
        console.error("Error trying to apply filters", initial_filters, ":", err);
      }
      return {
        rows_all_unfiltered: rows_all_unfiltered,
        rows_filtered: rows_filtered,
        rows_selected: rows_filtered,
        rows_highlighted: [],
      };
    }
    return {
      rows_all_unfiltered: [],
      rows_filtered: [],
      rows_selected: [],
      rows_highlighted: [],
    };
  }
  sendMessage(type: string, get_data: () => any): void {
    if (this.props.onChange !== null && this.props.onChange[type]) {
      const data = get_data();
      this.props.onChange[type](type, data);
    }
  }
  callSelectedUidsHooks = _.debounce(
    function (this: HiPlot): void {
      this.sendMessage(
        "selected_uids",
        function () {
          return this.state.rows_selected.map((row) => "" + row["uid"]);
        }.bind(this),
      );
    }.bind(this),
    200,
  );
  callFilteredUidsHooks = _.debounce(
    function (this: HiPlot): void {
      this.sendMessage(
        "filtered_uids",
        function () {
          return this.state.rows_filtered.map((row) => "" + row["uid"]);
        }.bind(this),
      );
    }.bind(this),
    200,
  );
  _loadExperiment(experiment: HiPlotExperiment) {
    // Uncompress if compressed
    if (experiment.datapoints === undefined) {
      experiment.datapoints = uncompress(experiment.datapoints_compressed);
    }

    // Generate dataset for Parallel Plot
    const dp_lookup = {};
    let initFilters = this.state.persistentState.get(PSTATE_FILTERS, []);
    const datasets = this.makeDatasets(experiment, dp_lookup, initFilters);
    if (datasets.rows_all_unfiltered === datasets.rows_filtered) {
      initFilters = [];
    }
    const params_def = infertypes(
      this.state.persistentState.children(PSTATE_PARAMS),
      datasets.rows_filtered,
      experiment.parameters_definition,
    );
    const params_def_unfiltered = infertypes(
      this.state.persistentState.children(PSTATE_PARAMS),
      datasets.rows_all_unfiltered,
      experiment.parameters_definition,
    );

    // Color handling
    function get_default_color() {
      if (experiment.colorby && params_def[experiment.colorby]) {
        return experiment.colorby;
      }
      function select_as_coloring_score(r) {
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
    let colorby = this.state.persistentState.get(PSTATE_COLOR_BY, get_default_color());
    if (params_def[colorby] === undefined) {
      colorby = get_default_color();
    }
    this.setState((_state, _props) => ({
      experiment: experiment,
      colormap: experiment.colormap,
      loadStatus: HiPlotLoadStatus.Loaded,
      dp_lookup: dp_lookup,
      colorby: colorby,
      params_def: params_def,
      params_def_unfiltered: params_def_unfiltered,
      rows_filtered_filters: initFilters,
      ...datasets,
    }));
  }
  getColorForRow(trial: Datapoint, alpha: number): string {
    return colorScheme(
      this.state.params_def[this.state.colorby],
      trial[this.state.colorby],
      alpha,
      this.state.colormap,
    );
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
    setupBrowserCompat(this.rootRef.current);
    if (this.state.darkModeSetting === "auto") {
      this.startAutoThemeListeners();
    }

    // Setup contextmenu when we right-click a parameter
    this.contextMenuRef.current.addCallback(this.columnContextMenu.bind(this), this);
    this.contextMenuRef.current.addCallback(this.columnContextMenuFooter.bind(this), this, "last");

    // Load experiment provided in constructor if any
    if (this.props.experiment) {
      this.loadWithPromise(
        new Promise(
          function (resolve, _reject) {
            resolve({ experiment: this.props.experiment });
          }.bind(this),
        ),
      );
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
        this.loadWithPromise(
          new Promise(
            function (resolve, _reject) {
              resolve({ experiment: this.props.experiment });
            }.bind(this),
          ),
        );
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
      this.state.loadPromise !== prevState.loadPromise
    ) {
      const prom = this.state.loadPromise.promise;
      prom
        .then((data: { error?: string; experiment?: HiPlotExperiment }) => {
          if (data.error !== undefined) {
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
        .catch((error) => {
          if (error.isCanceled) {
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
    this.state.params_def[column].type_options.forEach(
      function (this: HiPlot, possible_type) {
        const option = $('<a class="dropdown-item" href="#">').text(
          VAR_TYPE_TO_NAME[possible_type],
        );
        if (possible_type === this.state.params_def[column].type) {
          option.addClass("disabled").css("pointer-events", "none");
        }
        option.click(
          function (this: HiPlot, event) {
            contextmenu.css("display", "none");
            this.setState((state: Readonly<HiPlotState>, _props) => ({
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
          }.bind(this),
        );
        contextmenu.append(option);
      }.bind(this),
    );
    contextmenu.append($('<div class="dropdown-divider"></div>'));

    const ppRef = this.plugins_ref[DefaultPlugins.PARALLEL_PLOT];
    const pp = ppRef && ppRef.current ? (ppRef.current as unknown as ParallelPlot) : null;
    if (pp && pp.toggleInvertAxis) {
      const invert_axis = $('<a class="dropdown-item" href="#">Invert axis</a>');
      invert_axis.click(
        function (this: HiPlot, event) {
          const extent = pp.toggleInvertAxis(column);
          if (pp.update_ticks) {
            pp.update_ticks(column, extent);
          }
          event.preventDefault();
        }.bind(this),
      );
      contextmenu.append(invert_axis);
    }

    // Color by
    const link_colorize = $('<a class="dropdown-item" href="#">Use for coloring</a>');
    link_colorize.click(
      function (this: HiPlot, event) {
        this.setState({
          colorby: column,
        });
        event.preventDefault();
      }.bind(this),
    );
    if (this.state.colorby === column) {
      link_colorize.addClass("disabled").css("pointer-events", "none");
    }
    contextmenu.append(link_colorize);
  }
  columnContextMenuFooter(column: string, cm: HTMLDivElement) {
    const contextmenu = $(cm);
    const ppRef = this.plugins_ref[DefaultPlugins.PARALLEL_PLOT];
    const pp = ppRef && ppRef.current ? (ppRef.current as unknown as ParallelPlot) : null;
    contextmenu.append($('<div class="dropdown-divider"></div>'));

    if (pp && pp.can_hide_axis && pp.can_hide_axis(column)) {
      const hide_axis = $('<a class="dropdown-item" href="#">Hide axis</a>');
      hide_axis.click(
        function (this: HiPlot, event) {
          if (pp.remove_axis) {
            pp.remove_axis(column);
          }
          event.preventDefault();
        }.bind(this),
      );
      contextmenu.append(hide_axis);
    }

    const close_menu = $('<a class="dropdown-item" href="#">Close menu</a>');
    close_menu.click(
      function (this: HiPlot, event) {
        this.contextMenuRef.current.hide();
        event.preventDefault();
      }.bind(this),
    );
    contextmenu.append(close_menu);
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
    this.setState(
      function (this: HiPlot, state: Readonly<HiPlotState>, _props): Partial<HiPlotState> {
        const all_rows = state.rows_all_unfiltered;
        const new_pd = this.createNewParamsDef(all_rows);
        return {
          rows_selected: all_rows,
          rows_selected_filter: null,
          rows_filtered: all_rows,
          rows_filtered_filters: [],
          params_def: new_pd,
        };
      }.bind(this),
    );
  }
  filterRows(keep: boolean): void {
    /**
     * When we hit Keep (keep=true), or Exclude (keep=false) buttons
     */
    this.setState(
      function (this: HiPlot, state: Readonly<HiPlotState>, _props): Partial<HiPlotState> {
        const new_filtered = keep
          ? state.rows_selected
          : _.difference(state.rows_filtered, state.rows_selected);
        let filter: Filter = state.rows_selected_filter;
        if (!keep) {
          filter = {
            type: FilterType.Not,
            data: filter,
          };
        }
        const new_pd = this.createNewParamsDef(new_filtered);
        return {
          rows_filtered: new_filtered,
          params_def: new_pd,
          rows_selected_filter: null,
          rows_filtered_filters: state.rows_filtered_filters.concat([filter]),
        };
      }.bind(this),
    );
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
    const createPluginProps = function (
      this: HiPlot,
      name: string,
    ): React.ClassAttributes<React.ComponentClass<HiPlotPluginData>> & HiPlotPluginData {
      const baseProps = {
        ref: this.plugins_ref[name],
        ...(this.state.experiment.display_data && this.state.experiment.display_data[name]
          ? this.state.experiment.display_data[name]
          : {}),
        ...datasets,
        rows_selected_filter: this.state.rows_selected_filter,
        name: name,
        persistentState: this.state.persistentState.children(name),
        window_state: this.plugins_window_state[name],
        sendMessage: this.sendMessage.bind(this),
        get_color_for_row: this.getColorForRow.bind(this),
        experiment: this.state.experiment,
        params_def: this.state.params_def,
        params_def_unfiltered: this.state.params_def_unfiltered,
        dp_lookup: this.state.dp_lookup,
        colorby: this.state.colorby,
        render_row_text: this.renderRowText.bind(this),
        context_menu_ref: this.contextMenuRef,
        setSelected: this.setSelected.bind(this),
        setHighlighted: this.setHighlighted.bind(this),
        asserts: this.props.asserts,
      };
      // Add callback for ParallelPlot to notify when hidden columns change
      if (name === DefaultPlugins.PARALLEL_PLOT) {
        (baseProps as any).onHiddenColumnsChange = this.onHiddenColumnsChange.bind(this);
      }
      return baseProps;
    }.bind(this);
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
            restorableColumnsCount={this.state.restorableColumnsCount}
            onRestoreColumns={this.restoreAllColumns.bind(this)}
            {...controlProps}
          />
          {this.state.loadStatus === HiPlotLoadStatus.Error && (
            <ErrorDisplay error={this.state.error} />
          )}
          {this.state.loadStatus !== HiPlotLoadStatus.Loaded && (
            <DocAndCredits dark={this.state.dark} />
          )}
          <ContextMenu ref={this.contextMenuRef} />
          {this.state.loadStatus === HiPlotLoadStatus.Loaded && (
            <div>
              {(this.state.experiment.enabled_displays !== undefined
                ? this.state.experiment.enabled_displays
                : Object.keys(this.props.plugins)
              ).map(
                function (display_name: string) {
                  const plugin = this.props.plugins[display_name];
                  return (
                    <React.Fragment key={display_name}>
                      {React.createElement(plugin, createPluginProps(display_name))}
                    </React.Fragment>
                  );
                }.bind(this),
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
  getPlugin<P extends HiPlotPluginData, T extends React.Component<P>>(
    cls: React.ClassType<P, T, React.ComponentClass<P>>,
  ): T {
    const entries = Object.entries(this.props.plugins);
    for (let i = 0; i < entries.length; ++i) {
      if (entries[i][1] === cls) {
        return this.plugins_ref[entries[i][0]].current as unknown as T;
      }
    }
    throw new Error("Can not find plugin" + cls);
  }
  onHiddenColumnsChange(count: number): void {
    if (count !== this.state.restorableColumnsCount) {
      this.setState({ restorableColumnsCount: count });
    }
  }
  getRestorableColumnsCount(): number {
    const ppRef = this.plugins_ref[DefaultPlugins.PARALLEL_PLOT];
    if (ppRef && ppRef.current) {
      const pp = ppRef.current as unknown as ParallelPlot;
      if (pp.getRestorableColumnsCount) {
        return pp.getRestorableColumnsCount();
      }
    }
    return 0;
  }
  restoreAllColumns(): void {
    const ppRef = this.plugins_ref[DefaultPlugins.PARALLEL_PLOT];
    if (ppRef && ppRef.current) {
      const pp = ppRef.current as unknown as ParallelPlot;
      if (pp.restore_all_columns) {
        pp.restore_all_columns();
      }
    }
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
