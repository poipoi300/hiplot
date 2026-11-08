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
import { is_special_numeric } from "../lib/d3_scales";
import { labelTextFromHtml } from "../lib/escape";
import { columnNotation, formatterFor } from "../lib/numberformat";
import { mounted } from "../lib/refs";
import type { Datapoint } from "../types";
import {
  DEFAULT_ORBIT,
  eyePosition,
  type Orbit,
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
}

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
}

/** Point diameter in CSS pixels, smaller when there are many rows. */
const pointDiameter = (rows: number): number => (rows > 20_000 ? 2.5 : rows > 2_000 ? 3.5 : 5);
/** How far the pointer may be from a point to pick it, in CSS pixels. */
const HOVER_DISTANCE = 8;

/**
 * A 3D scatter of three columns, drawn with WebGL: drag to turn it, scroll to
 * zoom, double-click to reset the view. Points take the color-by colors; the
 * rows outside the selection stay as faint context.
 */
export class Scatter3D extends React.Component<Scatter3DProps, Scatter3DState> {
  canvasRef = React.createRef<HTMLCanvasElement>();
  renderer: PointsRenderer | null = null;
  positions: Float32Array = new Float32Array(0);
  selectedFlags: Uint8Array = new Uint8Array(0);
  private frame: number | null = null;
  private drag: { x: number; y: number } | null = null;
  private hovered: Datapoint | null = null;

  constructor(props: Scatter3DProps) {
    super(props);
    this.state = { orbit: DEFAULT_ORBIT, labels: [], hover: null };
  }

  componentDidMount(): void {
    const renderer = PointsRenderer.create(mounted(this.canvasRef));
    if (renderer === null) {
      throw new Error("The 3D scatter needs WebGL2");
    }
    this.renderer = renderer;
    // Not passive, so zooming does not also scroll the page.
    mounted(this.canvasRef).addEventListener("wheel", this.onWheel, { passive: false });
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
    if (prevProps !== this.props || prevState.orbit !== this.state.orbit) {
      this.scheduleDraw();
    }
  }

  componentWillUnmount(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
    }
    this.canvasRef.current?.removeEventListener("wheel", this.onWheel);
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
    this.setState({ labels });
  }

  private onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    this.drag = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    this.clearHover();
  };

  private onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (this.drag !== null) {
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      this.drag = { x: event.clientX, y: event.clientY };
      this.setState((state) => ({ orbit: rotateOrbit(state.orbit, dx, dy) }));
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    this.hoverAt(event.clientX - bounds.left, event.clientY - bounds.top);
  };

  private onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    this.drag = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.setState((state) => ({ orbit: zoomOrbit(state.orbit, event.deltaY) }));
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
    return (
      <div className={style.scatter3d} style={{ width, height }}>
        <canvas
          ref={this.canvasRef}
          role="img"
          aria-label="3D scatter plot: drag to turn, scroll to zoom, double-click to reset"
          style={{ width, height }}
          onPointerDown={this.onPointerDown}
          onPointerMove={this.onPointerMove}
          onPointerUp={this.onPointerUp}
          onPointerLeave={this.clearHover}
          onDoubleClick={() => this.setState({ orbit: DEFAULT_ORBIT })}
        />
        {this.state.labels.map((label) => (
          <span
            key={label.key}
            className={label.kind === "name" ? style.axisName : style.axisValue}
            style={{ left: label.x, top: label.y }}
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
    );
  }
}
