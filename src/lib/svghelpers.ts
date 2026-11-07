/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import type { ContextMenu } from "../contextmenu";
import style from "../hiplot.module.css";
import type { ParamDef } from "../infertypes";
import { IS_MOBILE } from "./browsercompat";

function leftPos(anchor: string, w: number, minmax?: [number, number]): number {
  let left = {
    end: -w,
    start: 0,
    left: 0,
    middle: -w / 2,
  }[anchor];
  if (minmax) {
    if (left < minmax[0]) {
      left = minmax[0];
    } else if (left + w > minmax[1]) {
      left = minmax[1] - w;
    }
  }
  return left;
}
export function foDynamicSizeFitContent(fo: SVGForeignObjectElement, minmax?: [number, number]) {
  const TOOLTIP_WIDTH_PX = 80;
  const w = Math.floor(fo.children[0].children[0].clientWidth + 2); // borders 2 px
  const h = Math.floor(fo.children[0].children[0].clientHeight + 2);
  const anchor = fo.getAttribute("text-anchor");
  const tooltip = fo.children[0].children[1] as HTMLDivElement;
  const anchor_x = leftPos(anchor, w, minmax);
  fo.setAttribute("x", `${anchor_x}`);
  // Set tooltip position - flip to left side if it would overflow the right edge
  if (tooltip) {
    // Calculate absolute position of the label
    const labelRight = minmax ? -minmax[0] + anchor_x + w : 0;
    const containerWidth = minmax ? minmax[1] - minmax[0] : 0;
    const spaceOnRight = containerWidth - labelRight;

    // If not enough space on right, position tooltip to the left of the label
    if (spaceOnRight < TOOLTIP_WIDTH_PX) {
      // Position tooltip to the left of the label
      tooltip.style.marginLeft = `${-TOOLTIP_WIDTH_PX - 5}px`;
    } else {
      // Position tooltip normally (to the right/below the label)
      tooltip.style.marginLeft = `0px`;
    }
    tooltip.style.width = `${TOOLTIP_WIDTH_PX}px`;
  }
  fo.style.width = `${w}px`;
  fo.style.height = `${h}px`;
  fo.style.overflow = "visible";
}

export function foCreateAxisLabel(
  pd: ParamDef,
  cm?: React.RefObject<ContextMenu>,
  tooltip: string = "Right click for options",
): SVGForeignObjectElement {
  const fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
  const span = d3
    .select(fo)
    .append("xhtml:div")
    .classed(style.tooltipContainer, true)
    .classed(style.label, true);

  // Long-press support for mobile devices
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  const LONG_PRESS_DURATION = 500; // ms

  const labelSpan = span
    .append("xhtml:span")
    .attr("class", pd.label_css)
    .classed("label-name", true)
    .classed(style.axisLabelText, true)
    .classed("d-inline-block", true)
    .html(pd.label_html)
    .on("contextmenu", (event: any) => {
      if (cm) {
        cm.current.show(event.pageX, event.pageY, pd.name);
        event.preventDefault();
        event.stopPropagation();
      }
    });

  // Add touch events for mobile long-press support
  if (cm) {
    labelSpan
      .on("touchstart", (event: TouchEvent) => {
        const touch = event.touches[0];
        longPressTimer = setTimeout(() => {
          cm.current.show(touch.pageX, touch.pageY, pd.name);
          longPressTimer = null;
        }, LONG_PRESS_DURATION);
      })
      .on("touchend touchcancel touchmove", () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      });
  }

  if (tooltip) {
    // Update tooltip text for mobile-friendly instructions only on mobile devices
    const displayTooltip = IS_MOBILE ? tooltip.replace("right click", "long-press") : tooltip;
    span
      .append("div")
      .classed(style.tooltiptext, true)
      .classed(style.tooltipBot, true)
      .text(displayTooltip);
  }
  return fo;
}
