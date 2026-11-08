/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The plots a display shows, as kept in the page state. A scatter panel is a
 * distribution of X alone, an XY scatter with Y, and a 3D scatter with Z too.
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
 * experiment asked for.
 */
export function distributionAxesToMigrate(
  saved: { panels: unknown; axis: unknown },
  requested: { enabled: boolean; axis: unknown },
): string[] {
  if (isDistributionPanels(saved.panels)) {
    return saved.panels.flatMap((panel) => (panel.axis === null ? [] : [panel.axis]));
  }
  if (typeof saved.axis === "string") {
    return [saved.axis];
  }
  return requested.enabled && typeof requested.axis === "string" ? [requested.axis] : [];
}

/** `panels`, plus a one-axis panel for each of `columns` that has none yet. */
export function withOneAxisPanels(
  panels: ReadonlyArray<ScatterPanel>,
  columns: ReadonlyArray<string>,
): ScatterPanel[] {
  const result = [...panels];
  for (const column of columns) {
    if (!result.some((panel) => panel.x === column && panel.y === null)) {
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

/** What a scatter panel draws, from the columns it was given. */
export type ScatterKind = "empty" | "distribution" | "xy" | "xyz";

export function scatterKind(panel: ScatterPanel): ScatterKind {
  if (panel.x === null) {
    return "empty";
  }
  if (panel.y === null) {
    return "distribution";
  }
  return panel.z === null ? "xy" : "xyz";
}

/**
 * Columns of a panel that the experiment no longer has are dropped, and a
 * coordinate can only be set once the previous one is: Z needs Y, Y needs X.
 */
export function normalizeScatterPanel(
  panel: ScatterPanel,
  columns: ReadonlySet<string>,
): ScatterPanel {
  const known = (column: string | null): string | null =>
    column !== null && columns.has(column) ? column : null;
  const x = known(panel.x);
  const y = x === null ? null : known(panel.y);
  const z = y === null ? null : known(panel.z);
  return { id: panel.id, x, y, z };
}
