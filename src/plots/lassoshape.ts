/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { has_non_finite, is_numeric_column, scale_of_type, with_outlier_band } from "../infertypes";
import {
  convert_to_categorical_input,
  d3_scale_categorical,
  is_special_numeric,
  type Scale,
} from "../lib/d3_scales";
import { type Datapoint, type DatapointValue, ParamType } from "../types";
import { type ScreenPoint, withinLasso } from "./lasso";
import { projectPoint } from "./orbit";

/** How a plot placed a categorical column along one of its axes. */
export interface CategoricalLassoAxis {
  col: string;
  type: ParamType.CATEGORICAL;
  range: [number, number];
}

/** How a plot placed a numeric column: the domain it showed, zoom included. */
export interface ContinuousLassoAxis {
  col: string;
  type: Exclude<ParamType, ParamType.CATEGORICAL>;
  domain: [number, number];
  range: [number, number];
}

/**
 * How a plot placed a column along one of its axes: the type its scale was
 * built for, and the range it spread it over. A lasso's filter builds the
 * scale again over the rows it filters, which give a column its categories
 * and percentiles.
 */
export type LassoAxis = CategoricalLassoAxis | ContinuousLassoAxis;

/** The rows a one-axis plot draws within a lasso's extent along its numeric axis, in pixels. */
export interface SpanLasso {
  kind: "span";
  axis: ContinuousLassoAxis;
  span: [number, number];
}

/** The categories whose bars a lasso spans across a one-axis plot. */
export interface CategoriesLasso {
  kind: "categories";
  col: string;
  values: string[];
}

/** The points of an XY plot inside a lasso, in the plot's pixels. */
export interface PlaneLasso {
  kind: "plane";
  x: LassoAxis;
  y: LassoAxis;
  /** The plot area, left, top, right and bottom: points zoomed out of it are not drawn. */
  area: [number, number, number, number];
  polygon: Array<[number, number]>;
}

/** The points a 3D view projects inside a lasso, in the canvas's pixels. */
export interface ViewLasso {
  kind: "view";
  x: LassoAxis;
  y: LassoAxis;
  z: LassoAxis;
  /** The view-projection matrix of the [-1, 1] cube, column-major, as the view drew it. */
  matrix: number[];
  /** The canvas size the matrix projected onto. */
  width: number;
  height: number;
  polygon: Array<[number, number]>;
}

/**
 * What a lasso drew around, saved in place of the rows it took: their
 * number does not change its size.
 */
export type LassoShape = SpanLasso | CategoriesLasso | PlaneLasso | ViewLasso;

/** The axis along which `scale`, built for `type`, placed column `col`. */
export function lassoAxis(col: string, type: ParamType, scale: Scale): LassoAxis {
  const range = scale.range();
  if (type === ParamType.CATEGORICAL) {
    if (scale.kind !== "categorical") {
      throw new Error(`Column "${col}" is categorical but its scale is not`);
    }
    return { col, type, range };
  }
  if (scale.kind !== "continuous") {
    throw new Error(`Column "${col}" is ${type} but its scale is categorical`);
  }
  const [low, high] = scale.domain();
  return { col, type, domain: [low, high], range };
}

/**
 * A lasso's points in whole pixels, each differing from the one before: a
 * long gesture saves as few points as it covers pixels.
 */
export function lassoPolygon(points: ReadonlyArray<ScreenPoint>): Array<[number, number]> {
  const polygon: Array<[number, number]> = [];
  for (const point of points) {
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    const last = polygon[polygon.length - 1];
    if (last === undefined || last[0] !== x || last[1] !== y) {
      polygon.push([x, y]);
    }
  }
  return polygon;
}

/**
 * Where an XY plot draws a value along an axis, in pixels; null when it
 * draws no point for the value.
 */
export function planeCoordinate(
  value: DatapointValue | undefined,
  scale: Scale,
  numeric: boolean,
): number | null {
  if (value === undefined || value === null || (numeric && (value === "inf" || value === "-inf"))) {
    return null;
  }
  const position = scale(value);
  return Number.isNaN(position) ? null : position;
}

/**
 * Where the 3D scatter places a value along an axis of its [-1, 1] cube; NaN
 * when it draws no point for the value.
 */
export function cubeCoordinate(
  value: DatapointValue | undefined,
  scale: Scale,
  numeric: boolean,
): number {
  if (value === undefined || (numeric && is_special_numeric(value))) {
    return Number.NaN;
  }
  const position = scale(value);
  return Number.isFinite(position) ? position : Number.NaN;
}

/** The values of column `col` among `rows`, the missing ones left out. */
function* columnValues(rows: ReadonlyArray<Datapoint>, col: string): Generator<DatapointValue> {
  for (const row of rows) {
    const value = row[col];
    if (value !== undefined) {
      yield value;
    }
  }
}

interface PlacedAxis {
  col: string;
  scale: Scale;
  numeric: boolean;
}

/**
 * The scale of `axis` built again over `rows`, with the band for inf, NaN
 * and missing values that XY plots draw when `withBand`.
 */
function placedAxis(
  axis: LassoAxis,
  rows: ReadonlyArray<Datapoint>,
  withBand: boolean,
): PlacedAxis {
  // Only categories and percentiles are placed among the column's distinct values.
  let distinct: DatapointValue[] | null = null;
  const distinctValues = (): DatapointValue[] => {
    distinct ??= Array.from(new Set(columnValues(rows, axis.col)));
    return distinct;
  };
  let scale: Scale;
  if (axis.type === ParamType.CATEGORICAL) {
    scale = d3_scale_categorical(distinctValues());
  } else {
    const domain = axis.domain;
    const continuous = scale_of_type(axis.col, axis.type, distinctValues, () => domain);
    // Percentiles span every value of the column, whatever domain they showed.
    if (axis.type === ParamType.NUMERICPERCENTILE && continuous.kind === "continuous") {
      continuous.domain(domain);
    }
    scale = continuous;
  }
  const values = (): Iterable<DatapointValue> => distinct ?? columnValues(rows, axis.col);
  const placed =
    withBand && scale.kind === "continuous"
      ? with_outlier_band(scale, axis.type, has_non_finite(values()))
      : scale;
  placed.range(axis.range);
  return { col: axis.col, scale: placed, numeric: is_numeric_column(axis.col, values()) };
}

const toScreen = (polygon: ReadonlyArray<[number, number]>): ScreenPoint[] =>
  polygon.map(([x, y]) => ({ x, y }));

/**
 * Whether a row lies inside `shape`, placed by its plot's scales built again
 * over `rows`, the rows the lasso was drawn over.
 */
export function lassoShapePredicate(
  shape: LassoShape,
  rows: ReadonlyArray<Datapoint>,
): (row: Datapoint) => boolean {
  switch (shape.kind) {
    case "categories": {
      const values = new Set(shape.values);
      return (row) => {
        const value = row[shape.col];
        return value !== undefined && values.has(convert_to_categorical_input(value));
      };
    }
    case "span": {
      const { scale, col } = placedAxis(shape.axis, rows, false);
      const [low, high] = shape.span;
      return (row) => {
        const position = scale(row[col]);
        return position >= low && position <= high;
      };
    }
    case "plane": {
      const inside = withinLasso(toScreen(shape.polygon));
      const x = placedAxis(shape.x, rows, true);
      const y = placedAxis(shape.y, rows, true);
      const [left, top, right, bottom] = shape.area;
      return (row) => {
        const px = planeCoordinate(row[x.col], x.scale, x.numeric);
        const py = planeCoordinate(row[y.col], y.scale, y.numeric);
        return (
          px !== null &&
          py !== null &&
          px >= left &&
          px <= right &&
          py >= top &&
          py <= bottom &&
          inside({ x: px, y: py })
        );
      };
    }
    case "view": {
      const inside = withinLasso(toScreen(shape.polygon));
      const x = placedAxis(shape.x, rows, false);
      const y = placedAxis(shape.y, rows, false);
      const z = placedAxis(shape.z, rows, false);
      const matrix = Float32Array.from(shape.matrix);
      // The view draws positions as 32-bit floats; the same rounding puts each point where it was drawn.
      const at = (axis: PlacedAxis, row: Datapoint): number =>
        Math.fround(cubeCoordinate(row[axis.col], axis.scale, axis.numeric));
      return (row) => {
        const point = projectPoint(
          matrix,
          at(x, row),
          at(y, row),
          at(z, row),
          shape.width,
          shape.height,
        );
        return point !== null && inside(point);
      };
    }
  }
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNumbers = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every(isFiniteNumber);

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContinuousAxis(value: unknown): value is ContinuousLassoAxis {
  return (
    isRecord(value) &&
    typeof value.col === "string" &&
    value.type !== ParamType.CATEGORICAL &&
    Object.values(ParamType).includes(value.type as ParamType) &&
    isNumbers(value.domain, 2) &&
    isNumbers(value.range, 2)
  );
}

function isLassoAxis(value: unknown): value is LassoAxis {
  if (isRecord(value) && value.type === ParamType.CATEGORICAL) {
    return typeof value.col === "string" && value.domain === undefined && isNumbers(value.range, 2);
  }
  return isContinuousAxis(value);
}

const isPolygon = (value: unknown): value is Array<[number, number]> =>
  Array.isArray(value) && value.every((point) => isNumbers(point, 2));

/** Validates a lasso's shape read back from untyped storage (the URL, a saved state). */
export function isLassoShape(value: unknown): value is LassoShape {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.kind) {
    case "categories":
      return (
        typeof value.col === "string" &&
        Array.isArray(value.values) &&
        value.values.every((category) => typeof category === "string")
      );
    case "span":
      return isContinuousAxis(value.axis) && isNumbers(value.span, 2);
    case "plane":
      return (
        isLassoAxis(value.x) &&
        isLassoAxis(value.y) &&
        isNumbers(value.area, 4) &&
        isPolygon(value.polygon)
      );
    case "view":
      return (
        isLassoAxis(value.x) &&
        isLassoAxis(value.y) &&
        isLassoAxis(value.z) &&
        isNumbers(value.matrix, 16) &&
        isFiniteNumber(value.width) &&
        isFiniteNumber(value.height) &&
        isPolygon(value.polygon)
      );
    default:
      return false;
  }
}
