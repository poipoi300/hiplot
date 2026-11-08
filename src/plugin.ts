/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type React from "react";
import type { ContextMenu } from "./contextmenu";
import type { Filter } from "./filters";
import type { ParamDefMap } from "./infertypes";
import type { ColorBinning, ColorMode } from "./lib/colors";
import type { PersistentState } from "./lib/savedstate";
import type {
  Datapoint,
  DatapointLookup,
  HiPlotExperiment,
  HiPlotLoadStatus,
  IDatasets,
  LoadURIPromise,
} from "./types";

export enum DefaultPlugins {
  // Names correspond to values of (python) hip.Displays. DISTRIBUTION has no
  // display of its own any more: distribution plots are one-axis scatter
  // panels, and saved ones move there (see distributionAxesToMigrate).
  PARALLEL_PLOT = "PARALLEL_PLOT",
  XY = "XY",
  DISTRIBUTION = "DISTRIBUTION",
  TABLE = "TABLE",
}

/** Per-plugin state that lives as long as the page (not persisted). */
export interface PluginWindowState {
  height?: number;
}

export interface HiPlotPluginDataWithoutDatasets {
  experiment: HiPlotExperiment;
  params_def: ParamDefMap;
  params_def_unfiltered: ParamDefMap;

  get_color_for_row: (row: Datapoint, opacity: number) => string;
  /** Colors of the color-by column, for displays that group rows by color. */
  color_binning: ColorBinning;
  /** What displays that overlap many rows show where they cross (see ColorMode). */
  color_mode: ColorMode;
  /** Whether the dark theme is active, for displays that draw outside CSS. */
  dark: boolean;
  render_row_text: (row: Datapoint) => string;
  dp_lookup: DatapointLookup;

  context_menu_ref?: React.RefObject<ContextMenu | null>;
  colorby: string;
  name: string;

  rows_selected_filter: Filter | null;

  // Data that persists until we close the window
  window_state: PluginWindowState;
  // Data that persists upon page reload, sharing link etc...
  persistentState: PersistentState;

  sendMessage: (type: string, data: () => unknown) => void;

  setSelected: (new_selected: Array<Datapoint>, filter: Filter | null) => void;
  setHighlighted: (new_highlighted: Array<Datapoint>) => void;
  /**
   * The header row's slot for a display's controls: null until it is
   * mounted, undefined where the display is used outside HiPlot's layout
   * (it then shows its controls itself).
   */
  header_toolbar?: HTMLElement | null;
  /** Tells the user, in a toast, about something refused or recovered from. */
  notify: (message: string) => void;

  asserts: boolean;
}

export interface HiPlotPluginData extends IDatasets, HiPlotPluginDataWithoutDatasets {}

export interface DataProviderProps {
  // Data that persists upon page reload, sharing link etc...
  persistentState: PersistentState;

  loadStatus: HiPlotLoadStatus; // Should not allow to load an xp when already loading another xp

  hasFocus: boolean;
  onFocusChange: (hasFocus: boolean) => void;

  onLoadExperiment: (load_promise: LoadURIPromise) => void;
}

/** A data provider instance; providers that can reload expose `refresh`. */
export interface DataProviderComponent extends React.Component<DataProviderProps> {
  refresh?(): LoadURIPromise | null;
}
export type DataProviderClass = new (props: DataProviderProps) => DataProviderComponent;
