/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import React from "react";
import { create_d3_scale_without_outliers, type ParamDefMap } from "../infertypes";
import type { ColorBinning, RGB } from "../lib/colors";
import { devicePixelShift } from "../lib/crisptext";
import { is_special_numeric } from "../lib/d3_scales";
import { labelTextFromHtml } from "../lib/escape";
import { fitColor } from "../lib/fitcolor";
import { columnNotation, formatterFor } from "../lib/numberformat";
import { mounted } from "../lib/refs";
import { planeFit } from "../stats/regression";
import { type Datapoint, ParamType } from "../types";
import { LASSO_GESTURE, lassoed, type ScreenPoint, WheelLatch } from "./lasso";
import { LassoSurface } from "./lassosurface";
import {
  DEFAULT_ORBIT,
  eyePosition,
  type Orbit,
  panOrbit,
  projectPoint,
  rotateOrbit,
  viewProjection,
  zoomOrbit,
} from "./orbit";
import style from "./plots.module.css";
import { PointsRenderer } from "./points_gl";

export interface ScatterAxes {
  x: string;
  y: string;
  z: string;
}

const AXES = ["x", "y", "z"] as const;
type AxisName = (typeof AXES)[number];

/**
 * Each row's position in the [-1, 1]^3 cube, x y z per row: the columns'
 * scales stretched over [-1, 1]. Missing and non-finite values are NaN, so
 * the row is not drawn.
 */
export function scatterPositions(
  rows: ReadonlyArray<Datapoint>,
  params_def: ParamDefMap,
  axes: ScatterAxes,
): Float32Array {
  const positions = new Float32Array(rows.length * 3);
  AXES.forEach((axis, offset) => {
    const pd = params_def[axes[axis]];
    const scale = create_d3_scale_without_outliers(pd);
    scale.range([-1, 1]);
    rows.forEach((row, index) => {
      const value = row[axes[axis]];
      const missing = value === undefined || (pd.numeric && is_special_numeric(value));
      const position = missing ? Number.NaN : scale(value);
      positions[index * 3 + offset] = Number.isFinite(position) ? position : Number.NaN;
    });
  });
  return positions;
}

/** Text at both ends of an axis: its smallest and largest value. */
function axisEnds(params_def: ParamDefMap, column: string): [string, string] {
  const scale = create_d3_scale_without_outliers(params_def[column]);
  const domain = scale.domain();
  if (scale.kind === "categorical") {
    return [String(domain[0]), String(domain[domain.length - 1])];
  }
  const ends = [Number(domain[0]), Number(domain[domain.length - 1])];
  const format = formatterFor(columnNotation(ends));
  return [format(ends[0]), format(ends[1])];
}

type Point3 = [number, number, number];

/**
 * The cube edge each axis is labelled along, as a function of the position t
 * in [-1, 1] and of how far (`out`, 1 on the edge) labels stand outside the
 * cube: X and Z along the bottom edges facing the camera, Y along the
 * vertical edge further left on screen.
 */
export function labelEdges(
  eye: readonly [number, number, number],
  screenX: (point: Point3) => number,
): { [axis in AxisName]: (t: number, out: number) => Point3 } {
  const sx = eye[0] >= 0 ? 1 : -1;
  const sz = eye[2] >= 0 ? 1 : -1;
  const back: Point3 = [sx, 0, -sz];
  const side: Point3 = [-sx, 0, sz];
  const [vx, , vz] = screenX(back) <= screenX(side) ? back : side;
  return {
    x: (t, out) => [t, -out, sz * out],
    z: (t, out) => [sx * out, -out, t],
    y: (t, out) => [vx * out, t, vz * out],
  };
}

interface Scatter3DProps {
  rows: ReadonlyArray<Datapoint>;
  selected: ReadonlyArray<Datapoint>;
  params_def: ParamDefMap;
  axes: ScatterAxes;
  color_binning: ColorBinning;
  colorby: string;
  dark: boolean;
  width: number;
  height: number;
  render_row_text: (row: Datapoint) => string;
  setHighlighted: (rows: Datapoint[]) => void;
  /** Makes the rows a lasso drew around the selection, in place of any other. */
  onLasso: (rows: Datapoint[]) => void;
}

/** What a drag does: turn the view or pan it (a lasso is the LassoSurface's). */
type DragMode = "orbit" | "pan";

/** The least-squares plane through the selected points, drawn as a grid in the cube. */
type PlaneState =
  | { kind: "fit"; path: string; r2: number; n: number }
  | { kind: "none"; reason: string };

/** Lines of the plane's grid in each direction, and points per line. */
const PLANE_GRID_LINES = 9;
const PLANE_LINE_POINTS = 25;

interface Label {
  key: string;
  x: number;
  y: number;
  text: string;
  kind: "name" | "value";
}

interface Scatter3DState {
  orbit: Orbit;
  labels: Label[];
  hover: { x: number; y: number; text: string } | null;
  plane: PlaneState;
}

/** A label's anchor on the nearest device pixel, where its text renders sharp. */
const onDevicePixel = (position: number): number =>
  position + devicePixelShift(position, window.devicePixelRatio);

/** Point diameter in CSS pixels, smaller when there are many rows. */
const pointDiameter = (rows: number): number => (rows > 20_000 ? 2.5 : rows > 2_000 ? 3.5 : 5);
/** How far the pointer may be from a point to pick it, in CSS pixels. */
const HOVER_DISTANCE = 8;

/** The controls, as the hint under the plot lists them. */
const CONTROLS_HINT = `Drag to turn · Right-, middle- or Shift-drag to pan · Wheel to zoom · ${LASSO_GESTURE} to lasso · Double-click to reset`;

/**
 * A 3D scatter of three columns, drawn with WebGL: drag to turn it,
 * right-, middle- or shift-drag to pan, scroll to zoom, ctrl-drag (cmd-drag
 * on a Mac) to lasso points into the selection, double-click to reset the view.
 * Points take the color-by colors; the rows outside the selection stay as
 * faint context. A least-squares plane through the selected points, fitted
 * in axis space (log axes in log space), is drawn as a grid.
 */
export class Scatter3D extends React.Component<Scatter3DProps, Scatter3DState> {
  canvasRef = React.createRef<HTMLCanvasElement>();
  renderer: PointsRenderer | null = null;
  positions: Float32Array = new Float32Array(0);
  selectedFlags: Uint8Array = new Uint8Array(0);
  private frame: number | null = null;
  private drag: { mode: DragMode; x: number; y: number } | null = null;
  private hovered: Datapoint | null = null;
  private readonly wheelLatch = new WheelLatch();
  /** The plane fitted to the current points and selection: y = a + b·x + c·z in the cube. */
  private plane: { a: number; b: number; c: number; r2: number; n: number } | null = null;

  constructor(props: Scatter3DProps) {
    super(props);
    this.state = {
      orbit: DEFAULT_ORBIT,
      labels: [],
      hover: null,
      plane: { kind: "none", reason: "" },
    };
  }

  componentDidMount(): void {
    const renderer = PointsRenderer.create(mounted(this.canvasRef));
    if (renderer === null) {
      throw new Error("The 3D scatter needs WebGL2");
    }
    this.renderer = renderer;
    // Not passive, so zooming does not also scroll the page.
    mounted(this.canvasRef).addEventListener("wheel", this.onWheel, { passive: false });
    // Every wheel event of the page, first: where each gesture started.
    window.addEventListener("wheel", this.recordWheel, { capture: true, passive: true });
    this.uploadPoints();
    this.uploadSelection();
    this.scheduleDraw();
  }

  componentDidUpdate(prevProps: Scatter3DProps, prevState: Scatter3DState): void {
    if (
      prevProps.rows !== this.props.rows ||
      prevProps.params_def !== this.props.params_def ||
      prevProps.color_binning !== this.props.color_binning ||
      prevProps.colorby !== this.props.colorby
    ) {
      this.uploadPoints();
    }
    if (prevProps.selected !== this.props.selected || prevProps.rows !== this.props.rows) {
      this.uploadSelection();
    }
    if (
      prevProps.selected !== this.props.selected ||
      prevProps.rows !== this.props.rows ||
      prevProps.params_def !== this.props.params_def
    ) {
      this.plane = null;
    }
    if (prevProps !== this.props || prevState.orbit !== this.state.orbit) {
      this.scheduleDraw();
    }
  }

  componentWillUnmount(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
    }
    this.canvasRef.current?.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("wheel", this.recordWheel, { capture: true });
    this.renderer?.dispose();
    this.renderer = null;
  }

  private uploadPoints(): void {
    const { rows, params_def, axes, color_binning, colorby } = this.props;
    this.positions = scatterPositions(rows, params_def, axes);
    const colors = new Uint8Array(rows.length * 4);
    rows.forEach((row, index) => {
      const { r, g, b } = color_binning.palette[color_binning.binOf(row[colorby])];
      colors.set([r, g, b, 200], index * 4);
    });
    this.renderer?.setPoints(this.positions, colors);
  }

  private uploadSelection(): void {
    const { rows, selected } = this.props;
    const flags = new Uint8Array(rows.length);
    if (selected === rows) {
      flags.fill(1);
    } else {
      const chosen = new Set(selected);
      rows.forEach((row, index) => {
        flags[index] = chosen.has(row) ? 1 : 0;
      });
    }
    this.selectedFlags = flags;
    this.renderer?.setSelection(flags);
  }

  private matrix(): Float32Array {
    return viewProjection(this.state.orbit, this.props.width / Math.max(1, this.props.height));
  }

  private themeColor(token: string): RGB {
    const value = getComputedStyle(mounted(this.canvasRef)).getPropertyValue(token);
    const parsed = d3.color(value.trim())?.rgb();
    if (!parsed) {
      throw new Error(`${token} is not a color: "${value}"`);
    }
    return { r: parsed.r, g: parsed.g, b: parsed.b };
  }

  private scheduleDraw(): void {
    if (this.frame !== null) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  private draw(): void {
    const renderer = this.renderer;
    if (renderer === null) {
      return;
    }
    const { width, height, rows, params_def, axes } = this.props;
    const ratio = window.devicePixelRatio;
    const canvas = mounted(this.canvasRef);
    // Assigning a canvas size reallocates its buffer, even to the same size.
    if (
      canvas.width !== Math.round(width * ratio) ||
      canvas.height !== Math.round(height * ratio)
    ) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const matrix = this.matrix();
    renderer.draw({
      matrix,
      pointSize: pointDiameter(rows.length) * ratio,
      contextColor: this.themeColor("--hip-context-line"),
      contextAlpha: this.props.dark ? 0.22 : 0.18,
      edgeColor: this.themeColor("--hip-axis"),
    });
    const edges = labelEdges(
      eyePosition(this.state.orbit),
      (point) => projectPoint(matrix, ...point, width, height)?.x ?? Number.POSITIVE_INFINITY,
    );
    const labels: Label[] = [];
    for (const axis of AXES) {
      const column = axes[axis];
      const [low, high] = axisEnds(params_def, column);
      const place = (key: string, at: Point3, text: string, kind: Label["kind"]) => {
        const point = projectPoint(matrix, ...at, width, height);
        if (point !== null) {
          labels.push({ key, ...point, text, kind });
        }
      };
      const pd = params_def[column];
      const name = labelTextFromHtml(pd.label_html, pd.name);
      if (axis === "y") {
        place(`${axis}-name`, edges.y(1.22, 1.08), name, "name");
      } else {
        place(`${axis}-name`, edges[axis](0, 1.32), name, "name");
      }
      place(`${axis}-low`, edges[axis](-0.86, 1.14), low, "value");
      place(`${axis}-high`, edges[axis](0.86, 1.14), high, "value");
    }
    this.setState({ labels, plane: this.projectedPlane(matrix) });
  }

  /** The least-squares plane through the selected points, fitted once per selection. */
  private fittedPlane(): { a: number; b: number; c: number; r2: number; n: number } | null {
    if (this.plane !== null) {
      return this.plane;
    }
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    for (let index = 0; index < this.selectedFlags.length; ++index) {
      if (this.selectedFlags[index] !== 0) {
        xs.push(this.positions[index * 3]);
        ys.push(this.positions[index * 3 + 1]);
        zs.push(this.positions[index * 3 + 2]);
      }
    }
    // Y is the vertical axis: y = a + b·x + c·z.
    const fit = planeFit(xs, zs, ys);
    this.plane = fit;
    return fit;
  }

  /** The fitted plane's grid, clipped to the cube and projected; or why there is none. */
  private projectedPlane(matrix: Float32Array): PlaneState {
    const { axes, params_def, width, height } = this.props;
    const categorical = AXES.find((axis) => params_def[axes[axis]].type === ParamType.CATEGORICAL);
    if (categorical !== undefined) {
      return { kind: "none", reason: `No plane fit: ${axes[categorical]} is categorical` };
    }
    const fit = this.fittedPlane();
    if (fit === null) {
      return { kind: "none", reason: "No plane fit: too few selected points" };
    }
    let path = "";
    const line = (point: (t: number) => [number, number]) => {
      let drawing = false;
      for (let step = 0; step < PLANE_LINE_POINTS; ++step) {
        const [x, z] = point(-1 + (2 * step) / (PLANE_LINE_POINTS - 1));
        const y = fit.a + fit.b * x + fit.c * z;
        const onScreen = Math.abs(y) <= 1 ? projectPoint(matrix, x, y, z, width, height) : null;
        if (onScreen === null) {
          drawing = false;
          continue;
        }
        path += `${drawing ? "L" : "M"}${onScreen.x.toFixed(1)} ${onScreen.y.toFixed(1)}`;
        drawing = true;
      }
    };
    for (let index = 0; index < PLANE_GRID_LINES; ++index) {
      const u = -1 + (2 * index) / (PLANE_GRID_LINES - 1);
      line((t) => [u, t]);
      line((t) => [t, u]);
    }
    return { kind: "fit", path, r2: fit.r2, n: fit.n };
  }

  /** What a press starts: middle, right or shift pans, anything else turns the view. */
  private dragModeOf(event: React.PointerEvent): DragMode {
    return event.button === 1 || event.button === 2 || event.shiftKey ? "pan" : "orbit";
  }

  private onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    this.drag = { mode: this.dragModeOf(event), x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    this.clearHover();
  };

  private onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const drag = this.drag;
    if (drag === null) {
      this.hoverAt(event.clientX - bounds.left, event.clientY - bounds.top);
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    this.drag = { ...drag, x: event.clientX, y: event.clientY };
    if (drag.mode === "pan") {
      this.setState((state) => ({
        orbit: panOrbit(state.orbit, dx, dy, this.props.height),
      }));
    } else {
      this.setState((state) => ({ orbit: rotateOrbit(state.orbit, dx, dy) }));
    }
  };

  private onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    this.drag = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  /**
   * Selects the points inside the lasso, among all the rows Keep and Exclude
   * left, selected or not: the lasso replaces the selection.
   */
  private onLasso = (polygon: ReadonlyArray<ScreenPoint>): void => {
    const { rows, width, height } = this.props;
    const matrix = this.matrix();
    const inside = lassoed(
      rows.length,
      (index) =>
        projectPoint(
          matrix,
          this.positions[index * 3],
          this.positions[index * 3 + 1],
          this.positions[index * 3 + 2],
          width,
          height,
        ),
      polygon,
    );
    this.props.onLasso(inside.map((index) => rows[index]));
  };

  private recordWheel = (event: WheelEvent): void => {
    this.wheelLatch.record(event.target, event.timeStamp);
  };

  /** Zooms, for wheel gestures that started on the plot; others scroll the page. */
  private onWheel = (event: WheelEvent): void => {
    if (!this.wheelLatch.startedInside(mounted(this.canvasRef))) {
      return;
    }
    event.preventDefault();
    this.setState((state) => ({ orbit: zoomOrbit(state.orbit, event.deltaY) }));
  };

  /** The middle button pans here: no autoscroll gizmo from the browser. */
  private onMouseDown = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    if (event.button === 1) {
      event.preventDefault();
    }
  };

  /** Names the selected point nearest to (x, y), when one is close enough. */
  hoverAt(x: number, y: number): void {
    const { width, height, rows } = this.props;
    const matrix = this.matrix();
    let nearest = -1;
    let nearestDistance = HOVER_DISTANCE;
    let nearestPoint = { x: 0, y: 0 };
    for (let index = 0; index < rows.length; ++index) {
      if (this.selectedFlags[index] === 0) {
        continue;
      }
      const point = projectPoint(
        matrix,
        this.positions[index * 3],
        this.positions[index * 3 + 1],
        this.positions[index * 3 + 2],
        width,
        height,
      );
      if (point === null || Number.isNaN(point.x) || Number.isNaN(point.y)) {
        continue;
      }
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = index;
        nearestPoint = point;
      }
    }
    if (nearest === -1) {
      this.clearHover();
      return;
    }
    const row = rows[nearest];
    this.setState({ hover: { ...nearestPoint, text: this.props.render_row_text(row) } });
    if (row !== this.hovered) {
      this.hovered = row;
      this.props.setHighlighted([row]);
    }
  }

  clearHover = (): void => {
    if (this.hovered !== null) {
      this.hovered = null;
      this.props.setHighlighted([]);
    }
    if (this.state.hover !== null) {
      this.setState({ hover: null });
    }
  };

  render(): React.ReactNode {
    const { width, height } = this.props;
    const { plane } = this.state;
    const color = fitColor(this.props.color_binning.palette, this.props.dark ? "dark" : "light");
    return (
      <LassoSurface onLasso={this.onLasso}>
        <div className={style.scatter3d} style={{ width, height }}>
          <canvas
            ref={this.canvasRef}
            role="img"
            aria-label={`3D scatter plot. ${CONTROLS_HINT}`}
            style={{ width, height }}
            onPointerDown={this.onPointerDown}
            onPointerMove={this.onPointerMove}
            onPointerUp={this.onPointerUp}
            onPointerLeave={this.clearHover}
            onMouseDown={this.onMouseDown}
            onContextMenu={(event) => event.preventDefault()}
            onDoubleClick={() => this.setState({ orbit: DEFAULT_ORBIT })}
          />
          <svg className={style.overlay} width={width} height={height} aria-hidden="true">
            {plane.kind === "fit" && (
              <path className={style.plane} d={plane.path} stroke={color} data-testid="plane-fit" />
            )}
          </svg>
          <div className={style.hint} data-testid="scatter3d-hint">
            <span>{CONTROLS_HINT}</span>
            <span style={{ color: plane.kind === "fit" ? color : undefined }}>
              {plane.kind === "fit"
                ? `Plane: least squares in axis space, R² ${plane.r2.toFixed(2)}, n ${plane.n}`
                : plane.reason}
            </span>
          </div>
          {this.state.labels.map((label) => (
            <span
              key={label.key}
              className={label.kind === "name" ? style.axisName : style.axisValue}
              style={{ left: onDevicePixel(label.x), top: onDevicePixel(label.y) }}
              data-axis-label={label.key}
            >
              {label.text}
            </span>
          ))}
          {this.state.hover !== null && (
            <>
              <span
                className={style.hoverRing}
                style={{ left: this.state.hover.x, top: this.state.hover.y }}
              />
              <span
                className={style.hoverText}
                style={{ left: this.state.hover.x, top: this.state.hover.y }}
                data-testid="scatter3d-tooltip"
              >
                {this.state.hover.text}
              </span>
            </>
          )}
        </div>
      </LassoSurface>
    );
  }
}
