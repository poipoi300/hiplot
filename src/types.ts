/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** A cell value as it arrives from Python or a CSV: JSON scalars, with NaN and Infinity kept. */
export type DatapointValue = string | number | boolean | null | undefined;

/** One row: its identity plus one value per column. */
export interface Datapoint {
  uid: string;
  from_uid: string | null;
  [column: string]: DatapointValue;
}
export interface DatapointLookup {
  [key: string]: Datapoint;
}

export interface IDatasets {
  rows_all_unfiltered: Array<Datapoint>; // Everything returned by the server
  rows_filtered: Array<Datapoint>; // Everything after filtering (`Keep` / `Exclude`)
  rows_selected: Array<Datapoint>; // What we currently select (with parallel plot)
  rows_highlighted: Array<Datapoint>; // What is highlighted (when we hover a row)
}

export enum ParamType {
  CATEGORICAL = "categorical",
  NUMERIC = "numeric",
  NUMERICLOG = "numericlog",
  NUMERICPERCENTILE = "numericpercentile",
  TIMESTAMP = "timestamp",
}

export interface HiPlotValueDef {
  // Mirror of python `hip.ValueDef`
  type: ParamType | null;
  colors: { [value: string]: string } | null;
  colormap: string | null;
  force_value_min: number | null;
  force_value_max: number | null;
  label_css: string | null;
  label_html: string | null;
}

/** Mirror of python `hip.Datapoint`, as serialized in an experiment. */
export interface RawDatapoint {
  uid: string;
  from_uid: string | null;
  values: { [column: string]: DatapointValue };
}

export interface DatapointsCompressed {
  columns: Array<string>;
  // Each row is [uid, from_uid, ...one value per column]
  rows: Array<Array<DatapointValue>>;
}

/** A JSON stand-in for a float JSON cannot represent (see `hiplot/compress.py`). */
export interface NonFiniteValue {
  $f: "inf" | "-inf" | "nan";
}

/** Column-major datapoints, as `hiplot/compress.py:compress_columnar` writes them. */
export interface DatapointsColumnar {
  uid: Array<string>;
  from_uid: Array<string | null>;
  columns: { [column: string]: Array<DatapointValue | NonFiniteValue> };
  // Rows that have no value at all for a column (their slot holds null)
  missing: { [column: string]: Array<number> };
}

export interface HiPlotExperiment {
  // Mirror of python `hip.Experiment`
  datapoints?: Array<RawDatapoint>;
  datapoints_compressed?: DatapointsCompressed;
  datapoints_columnar?: DatapointsColumnar;
  parameters_definition?: { [key: string]: HiPlotValueDef };
  colormap?: string;
  colorby?: string;
  weightcolumn?: string;
  display_data?: { [display: string]: { [setting: string]: unknown } };
  enabled_displays?: Array<string>;
}

// biome-ignore lint/complexity/noStaticOnlyClass: `hiplot.Experiment.from_iterable` is public library API.
export class Experiment {
  static from_iterable(rows: Iterable<{ [column: string]: DatapointValue }>): HiPlotExperiment {
    return {
      datapoints: Array.from(rows, (row, index): RawDatapoint => {
        const { uid, from_uid, ...values } = row;
        return {
          uid: uid !== undefined && uid !== null ? String(uid) : `${index}`,
          from_uid: from_uid !== undefined && from_uid !== null ? String(from_uid) : null,
          values,
        };
      }),
      parameters_definition: {},
      display_data: {},
    };
  }
}

export type LoadURIPromiseResult = { experiment: HiPlotExperiment } | { error: string };
export type LoadURIPromise = Promise<LoadURIPromiseResult>;

export enum HiPlotLoadStatus {
  None,
  Loading,
  Loaded,
  Error,
}

export const PSTATE_COLOR_BY = "color_by";
export const PSTATE_COLOR_MAP = "color_map";
export const PSTATE_COLOR_MODE = "color_mode";
export const PSTATE_PARAMS = "params";
export const PSTATE_FILTERS = "filters";
