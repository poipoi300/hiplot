/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import React from "react";
import { MIN_LASSO_POINTS, type ScreenPoint, startsLasso } from "./lasso";
import style from "./plots.module.css";

interface LassoSurfaceProps {
  /** A lasso drawn over the surface, in CSS pixels from its top left corner. */
  onLasso: (polygon: ScreenPoint[]) => void;
  children: React.ReactNode;
}

interface LassoSurfaceState {
  /** The lasso being drawn. */
  polygon: ScreenPoint[] | null;
}

/**
 * Wraps a plot so that a Ctrl-drag (or Cmd-drag) anywhere over it draws a
 * lasso, whatever a plain drag does there: the press is taken in the capture
 * phase and cancelled, so the plot underneath (a d3 brush, an orbit) never
 * sees it, and the pointer stays captured until the lasso closes.
 */
export class LassoSurface extends React.Component<LassoSurfaceProps, LassoSurfaceState> {
  state: LassoSurfaceState = { polygon: null };

  private pointAt(event: React.PointerEvent<HTMLDivElement>): ScreenPoint {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  private onPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!startsLasso(event)) {
      return;
    }
    // Cancelling the press also stops the mouse events d3 listens to.
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    this.setState({ polygon: [this.pointAt(event)] });
  };

  private onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (this.state.polygon === null) {
      return;
    }
    event.stopPropagation();
    const point = this.pointAt(event);
    this.setState(({ polygon }) => ({ polygon: polygon === null ? null : [...polygon, point] }));
  };

  private onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const polygon = this.state.polygon;
    if (polygon === null) {
      return;
    }
    event.stopPropagation();
    this.setState({ polygon: null });
    if (polygon.length >= MIN_LASSO_POINTS) {
      this.props.onLasso(polygon);
    }
  };

  private onPointerCancel = (): void => {
    this.setState({ polygon: null });
  };

  /** On a Mac, a Ctrl-press is also a right click: no menu while a lasso is drawn. */
  private onContextMenuCapture = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (this.state.polygon !== null) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  render(): React.ReactNode {
    const { polygon } = this.state;
    return (
      <div
        className={
          polygon === null ? style.lassoSurface : `${style.lassoSurface} ${style.lassoing}`
        }
        onPointerDownCapture={this.onPointerDownCapture}
        onPointerMove={this.onPointerMove}
        onPointerUp={this.onPointerUp}
        onPointerCancel={this.onPointerCancel}
        onContextMenuCapture={this.onContextMenuCapture}
      >
        {this.props.children}
        {polygon !== null && (
          <svg className={style.lassoOverlay} aria-hidden="true">
            <polygon
              className={style.lasso}
              points={polygon.map(({ x, y }) => `${x},${y}`).join(" ")}
              data-testid="lasso"
            />
          </svg>
        )}
      </div>
    );
  }
}
