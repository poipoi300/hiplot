/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { DatapointsCompressed, DatapointValue, RawDatapoint } from "../types";

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
