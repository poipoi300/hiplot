/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import _ from "underscore";

/**
 * The plots a display shows, as kept in the page state. Each of a scatter
 * panel's X, Y and Z holds a column or none; the columns set, in that order,
 * are what it plots (see `plottedColumns`).
 */
export interface ScatterPanel {
  id: string;
  x: string | null;
  y: string | null;
  z: string | null;
}

export interface DistributionPanel {
  id: string;
  axis: string | null;
}

const isRecord = (value: unknown): value is { [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isColumnOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

export const isScatterPanels = (value: unknown): value is ScatterPanel[] =>
  Array.isArray(value) &&
  value.every(
    (panel) =>
      isRecord(panel) &&
      typeof panel.id === "string" &&
      isColumnOrNull(panel.x) &&
      isColumnOrNull(panel.y) &&
      isColumnOrNull(panel.z),
  );

export const isDistributionPanels = (value: unknown): value is DistributionPanel[] =>
  Array.isArray(value) &&
  value.every(
    (panel) => isRecord(panel) && typeof panel.id === "string" && isColumnOrNull(panel.axis),
  );

/**
 * The columns of distribution plots a page saved before they became one-axis
 * scatter panels: its saved panels, else the single axis older pages kept,
 * else, the first time a page shows its experiment, the axis the
 * experiment's DISTRIBUTION display data asks for. That request stands
 * whether or not the experiment lists DISTRIBUTION among its displays, which
 * newer experiments no longer do by default.
 */
export function distributionAxesToMigrate(
  saved: { panels: unknown; axis: unknown },
  requestedAxis: unknown,
): string[] {
  if (isDistributionPanels(saved.panels)) {
    return saved.panels.flatMap((panel) => (panel.axis === null ? [] : [panel.axis]));
  }
  if (typeof saved.axis === "string") {
    return [saved.axis];
  }
  return typeof requestedAxis === "string" ? [requestedAxis] : [];
}

/** `panels`, plus a one-axis panel for each of `columns` that has none yet. */
export function withOneAxisPanels(
  panels: ReadonlyArray<ScatterPanel>,
  columns: ReadonlyArray<string>,
): ScatterPanel[] {
  const result = [...panels];
  for (const column of columns) {
    if (!result.some((panel) => _.isEqual(plottedColumns(panel), [column]))) {
      result.push({ id: nextPanelId(result), x: column, y: null, z: null });
    }
  }
  return result;
}

/** An id no panel of `panels` has: one more than the largest numeric id. */
export function nextPanelId(panels: ReadonlyArray<{ id: string }>): string {
  const largest = panels.reduce((most, panel) => Math.max(most, Number(panel.id) || 0), 0);
  return String(largest + 1);
}

/**
 * The columns a panel plots: those of X, Y and Z that are set, in that
 * order. The first runs along the horizontal axis and the second the
 * vertical one, so X = None with Y and Z set draws Y across and Z up.
 */
export function plottedColumns(panel: ScatterPanel): string[] {
  return [panel.x, panel.y, panel.z].filter((column) => column !== null);
}

/** What a scatter panel draws, from how many columns it plots. */
export type ScatterKind = "empty" | "distribution" | "xy" | "xyz";

const KINDS: ReadonlyArray<ScatterKind> = ["empty", "distribution", "xy", "xyz"];

export function scatterKind(panel: ScatterPanel): ScatterKind {
  return KINDS[plottedColumns(panel).length];
}

/** Columns of a panel that the experiment no longer has are dropped; the others stay put. */
export function normalizeScatterPanel(
  panel: ScatterPanel,
  columns: ReadonlySet<string>,
): ScatterPanel {
  const known = (column: string | null): string | null =>
    column !== null && columns.has(column) ? column : null;
  return { id: panel.id, x: known(panel.x), y: known(panel.y), z: known(panel.z) };
}
