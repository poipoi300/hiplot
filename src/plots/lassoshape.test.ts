import { describe, expect, test } from "bun:test";
import { apply_filter, apply_filters, type Filter, FilterType, lassoFilter } from "../filters";
import { create_d3_scale, create_d3_scale_without_outliers, infertypes } from "../infertypes";
import { PersistentStateInMemory } from "../lib/savedstate";
import { type Datapoint, ParamType } from "../types";
import { type ScreenPoint, withinLasso } from "./lasso";
import {
  isLassoShape,
  lassoAxis,
  lassoPolygon,
  type PlaneLasso,
  planeCoordinate,
  type ViewLasso,
} from "./lassoshape";
import { DEFAULT_ORBIT, projectPoint, viewProjection } from "./orbit";
import { scatterPositions } from "./scatter3d";

const OPTIMIZERS = ["adam", "sgd", "rmsprop", "lamb"];

/** Rows with a linear, a percentile, a log and a categorical column; some losses are inf or NaN. */
const rows: Datapoint[] = Array.from({ length: 400 }, (_, i) => ({
  uid: `${i}`,
  from_uid: null,
  step: i,
  loss: i % 37 === 0 ? (i % 2 === 0 ? "inf" : Number.NaN) : Math.exp(((i * 7919) % 400) / 40),
  lr: 10 ** -(((i * 104729) % 400) / 80),
  opt: OPTIMIZERS[(i * 31) % OPTIMIZERS.length],
}));

const paramsDef = (table: Datapoint[]) =>
  infertypes(
    new PersistentStateInMemory("", {
      "loss.type": ParamType.NUMERICPERCENTILE,
      "lr.type": ParamType.NUMERICLOG,
    }),
    table,
  );

/** The polygon a lasso saves, and its points on screen. */
const polygon = (points: Array<[number, number]>): [Array<[number, number]>, ScreenPoint[]] => [
  points,
  points.map(([x, y]) => ({ x, y })),
];

/** A lasso as the URL gives it back. */
const saved = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("XY lassos", () => {
  // The XY plot's area, left, top, right and bottom.
  const area: [number, number, number, number] = [40, 10, 440, 310];

  test("keep the points drawn inside them and inside the plot area, at the plot's zoom", () => {
    const params_def = paramsDef(rows);
    const x = create_d3_scale(params_def.step).range([area[0], area[2]]);
    if (x.kind !== "continuous") throw new Error("Expected a continuous step axis");
    // Zoomed in: the lasso below reaches past the plot area, over points zoomed out of view.
    x.domain([x.invert(100), x.invert(380)]);
    const y = create_d3_scale(params_def.loss).range([area[3], area[1]]);
    expect(y.kind === "continuous" && y.hasOutlierBand).toBe(true);
    const [points, screen] = polygon([
      [10, 0],
      [300, 5],
      [460, 200],
      [200, 320],
      [60, 250],
    ]);
    const inside = withinLasso(screen);
    const drawnInside = rows.filter((row) => {
      const px = planeCoordinate(row.step, x, true);
      const py = planeCoordinate(row.loss, y, true);
      return (
        px !== null &&
        py !== null &&
        px >= area[0] &&
        px <= area[2] &&
        py >= area[1] &&
        py <= area[3] &&
        inside({ x: px, y: py })
      );
    });
    const shape: PlaneLasso = {
      kind: "plane",
      x: lassoAxis("step", x.paramType, x),
      y: lassoAxis("loss", y.paramType, y),
      area,
      polygon: points,
    };
    const lassoed = apply_filter(rows, lassoFilter(saved(shape)));
    expect(lassoed).toEqual(drawnInside);
    expect(lassoed.length).toBeGreaterThan(20);
    // NaN losses, drawn in the band at the top, are taken where the lasso covers it.
    expect(lassoed.some((row) => Number.isNaN(row.loss))).toBe(true);
    // Points zoomed out of view are not taken, though the lasso reaches over them.
    const [zoomStart] = x.domain();
    expect(lassoed.every((row) => Number(row.step) >= zoomStart)).toBe(true);
  });

  test("keep the categories drawn inside them", () => {
    const params_def = paramsDef(rows);
    const x = create_d3_scale(params_def.opt).range([area[0], area[2]]);
    const y = create_d3_scale(params_def.lr).range([area[3], area[1]]);
    const [points, screen] = polygon([
      [area[0], area[1]],
      [240, area[1]],
      [240, 200],
      [area[0], 200],
    ]);
    const inside = withinLasso(screen);
    const shape: PlaneLasso = {
      kind: "plane",
      x: lassoAxis("opt", x.paramType, x),
      y: lassoAxis("lr", y.paramType, y),
      area,
      polygon: points,
    };
    const lassoed = apply_filter(rows, lassoFilter(saved(shape)));
    expect(lassoed).toEqual(rows.filter((row) => inside({ x: x(row.opt), y: y(row.lr) })));
    expect(new Set(lassoed.map((row) => row.opt))).toEqual(new Set(["adam", "lamb"]));
  });
});

test("a 3D lasso keeps the points the view projects inside it", () => {
  const params_def = paramsDef(rows);
  const axes = { x: "lr", y: "loss", z: "opt" };
  const positions = scatterPositions(rows, params_def, axes);
  const [width, height] = [600, 400];
  const matrix = viewProjection(DEFAULT_ORBIT, width / height);
  const [points, screen] = polygon([
    [150, 60],
    [470, 90],
    [420, 330],
    [200, 300],
  ]);
  const inside = withinLasso(screen);
  const projectedInside = rows.filter((_row, index) => {
    const point = projectPoint(
      matrix,
      positions[index * 3],
      positions[index * 3 + 1],
      positions[index * 3 + 2],
      width,
      height,
    );
    return point !== null && inside(point);
  });
  const axis = (column: string) =>
    lassoAxis(
      column,
      params_def[column].type,
      create_d3_scale_without_outliers(params_def[column]).range([-1, 1]),
    );
  const shape: ViewLasso = {
    kind: "view",
    x: axis(axes.x),
    y: axis(axes.y),
    z: axis(axes.z),
    matrix: Array.from(matrix),
    width,
    height,
    polygon: points,
  };
  const lassoed = apply_filter(rows, lassoFilter(saved(shape)));
  expect(lassoed).toEqual(projectedInside);
  expect(lassoed.length).toBeGreaterThan(20);
  expect(lassoed.length).toBeLessThan(rows.length - 20);
});

test("a lasso drawn after Exclude replays over the rows Exclude left", () => {
  const excluded: Filter = {
    type: FilterType.Not,
    data: {
      type: FilterType.Range,
      data: { col: "step", type: ParamType.NUMERIC, min: 0, max: 150 },
    },
  };
  const left = apply_filter(rows, excluded);
  // Percentiles and categories are those of the rows left, as the plot drew them.
  const params_def = paramsDef(left);
  const x = create_d3_scale(params_def.loss).range([0, 400]);
  const y = create_d3_scale(params_def.opt).range([300, 0]);
  const lasso = lassoFilter({
    kind: "plane",
    x: lassoAxis("loss", x.paramType, x),
    y: lassoAxis("opt", y.paramType, y),
    area: [0, 0, 400, 300],
    polygon: [
      [0, 0],
      [200, 0],
      [200, 300],
      [0, 300],
    ],
  });
  const kept = apply_filter(left, lasso);
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.length).toBeLessThan(left.length);
  expect(apply_filters(rows, [excluded, saved(lasso)])).toEqual(kept);
});

describe("one-axis lassos", () => {
  const span = (column: string, table: Datapoint[], [low, high]: [number, number]) => {
    const pd = paramsDef(table)[column];
    const scale = create_d3_scale_without_outliers(pd).range([0, 300]);
    const axis = lassoAxis(column, pd.type, scale);
    if (axis.type === ParamType.CATEGORICAL) throw new Error("Expected a numeric axis");
    return { scale, filter: lassoFilter(saved({ kind: "span", axis, span: [low, high] })) };
  };

  test("keep the rows drawn within their extent along the axis", () => {
    const { scale, filter } = span("lr", rows, [40, 180]);
    const lassoed = apply_filter(rows, filter);
    expect(lassoed).toEqual(rows.filter((row) => scale(row.lr) >= 40 && scale(row.lr) <= 180));
    expect(lassoed.length).toBeGreaterThan(20);
    expect(lassoed.length).toBeLessThan(rows.length - 20);
  });

  test("past the end of a percentile axis take nothing", () => {
    expect(apply_filter(rows, span("loss", rows, [-50, -10]).filter)).toEqual([]);
    expect(apply_filter(rows, span("loss", rows, [310, 400]).filter)).toEqual([]);
  });

  test("on a column of one value take its rows only where they are drawn", () => {
    const constant = rows.slice(0, 5).map((row) => ({ ...row, step: 5 }));
    expect(apply_filter(constant, span("step", constant, [0, 100]).filter)).toEqual([]);
    expect(apply_filter(constant, span("step", constant, [100, 200]).filter)).toEqual(constant);
  });
});

test("a lasso saves its points in whole pixels, each differing from the one before", () => {
  expect(
    lassoPolygon([
      { x: 1.2, y: 2.6 },
      { x: 0.8, y: 3.4 },
      { x: 5.5, y: 3 },
      { x: 1, y: 3 },
    ]),
  ).toEqual([
    [1, 3],
    [6, 3],
    [1, 3],
  ]);
});

describe("lassos read back from storage", () => {
  const axis = { col: "step", type: ParamType.NUMERIC, domain: [0, 1], range: [0, 100] };
  const plane = {
    kind: "plane",
    x: axis,
    y: { col: "opt", type: ParamType.CATEGORICAL, range: [100, 0] },
    area: [0, 0, 100, 100],
    polygon: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
  };

  test("are accepted when well formed", () => {
    expect(isLassoShape(plane)).toBe(true);
    expect(isLassoShape({ kind: "span", axis, span: [10, 20] })).toBe(true);
    expect(isLassoShape({ kind: "categories", col: "opt", values: ["sgd"] })).toBe(true);
    // A gesture that covered fewer than three pixels takes nothing, and still loads.
    expect(isLassoShape({ ...plane, polygon: plane.polygon.slice(0, 2) })).toBe(true);
    expect(
      isLassoShape({
        ...plane,
        kind: "view",
        z: axis,
        matrix: Array.from({ length: 16 }, () => 0),
        width: 10,
        height: 10,
      }),
    ).toBe(true);
  });

  test("are rejected when malformed", () => {
    for (const value of [
      { ...plane, kind: "view" },
      { ...plane, x: { col: "step", type: ParamType.NUMERIC, range: [0, 100] } },
      { ...plane, y: { ...plane.y, domain: [0, 1] } },
      { kind: "span", axis: plane.y, span: [0, 1] },
      { kind: "span", axis, span: [0] },
      { kind: "categories", col: "opt", values: ["sgd", 3] },
      { ...plane, area: [0, 0, 100] },
      {
        ...plane,
        polygon: [
          [0, 0],
          [1, Number.NaN],
          [0, 1],
        ],
      },
    ]) {
      expect(isLassoShape(value)).toBe(false);
    }
  });
});
