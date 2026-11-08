/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** The rows' uid: offered in the Columns menu, but an identifier, not drawn unless asked for. */
export const UID_COLUMN = "uid";

/**
 * The columns the parallel plot hides while the page has no choice of its
 * own saved: those the experiment hides, and the uid unless the experiment
 * places it in its axis order.
 */
export function defaultHiddenColumns(
  hide: ReadonlyArray<string>,
  order: ReadonlyArray<string>,
): string[] {
  if (order.includes(UID_COLUMN) || hide.includes(UID_COLUMN)) {
    return [...hide];
  }
  return [...hide, UID_COLUMN];
}
