/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  Datapoint,
  DatapointsColumnar,
  DatapointsCompressed,
  DatapointValue,
  HiPlotExperiment,
  NonFiniteValue,
  RawDatapoint,
} from "../types";

const NON_FINITE: { [encoded in NonFiniteValue["$f"]]: number } = {
  inf: Infinity,
  "-inf": -Infinity,
  nan: Number.NaN,
};

function decodeValue(value: DatapointValue | NonFiniteValue): DatapointValue {
  return typeof value === "object" && value !== null ? NON_FINITE[value.$f] : value;
}

// See `compress_columnar` in `compress.py`
export function uncompressColumnar(columnar: DatapointsColumnar): RawDatapoint[] {
  const datapoints: RawDatapoint[] = columnar.uid.map((uid, index) => ({
    uid,
    from_uid: columnar.from_uid[index],
    values: {},
  }));
  for (const [column, values] of Object.entries(columnar.columns)) {
    values.forEach((value, index) => {
      datapoints[index].values[column] = decodeValue(value);
    });
  }
  for (const [column, rows] of Object.entries(columnar.missing)) {
    for (const index of rows) {
      delete datapoints[index].values[column];
    }
  }
  return datapoints;
}

/** The datapoints of an experiment, whichever encoding it arrived in. */
export function experimentDatapoints(experiment: HiPlotExperiment): RawDatapoint[] {
  if (experiment.datapoints !== undefined) {
    return experiment.datapoints;
  }
  if (experiment.datapoints_columnar !== undefined) {
    return uncompressColumnar(experiment.datapoints_columnar);
  }
  if (experiment.datapoints_compressed !== undefined) {
    return uncompress(experiment.datapoints_compressed);
  }
  return [];
}

/** Rows straight from column-major datapoints, without an intermediate per-row object. */
function columnarRows(columnar: DatapointsColumnar): Datapoint[] {
  const rows: Datapoint[] = columnar.uid.map((uid, index) => ({
    uid,
    from_uid: columnar.from_uid[index],
  }));
  for (const [column, values] of Object.entries(columnar.columns)) {
    values.forEach((value, index) => {
      rows[index][column] = decodeValue(value);
    });
  }
  for (const [column, missing] of Object.entries(columnar.missing)) {
    for (const index of missing) {
      delete rows[index][column];
    }
  }
  return rows;
}

/** One flat row per datapoint (its values plus `uid` and `from_uid`). */
export function experimentRows(experiment: HiPlotExperiment): Datapoint[] {
  if (experiment.datapoints === undefined && experiment.datapoints_columnar !== undefined) {
    return columnarRows(experiment.datapoints_columnar);
  }
  return experimentDatapoints(experiment).map((t) => ({
    ...t.values,
    uid: t.uid,
    from_uid: t.from_uid,
  }));
}

// See `compress.py` for compression code on the python side
export function uncompress(compressed_data: DatapointsCompressed): RawDatapoint[] {
  const columns = compressed_data.columns;
  return compressed_data.rows.map((row) => {
    const values: { [column: string]: DatapointValue } = {};
    columns.forEach((column, i) => {
      values[column] = row[i + 2];
    });
    const [uid, from_uid] = row;
    return {
      uid: String(uid),
      from_uid: from_uid === null || from_uid === undefined ? null : String(from_uid),
      values,
    };
  });
}
