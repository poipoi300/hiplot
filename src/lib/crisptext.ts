/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * SVG text drawn at a fractional pixel is smeared over two rows or columns
 * of device pixels: small labels turn gray and soft. Axis tick labels get
 * fractional positions from their scales and from d3's `dy` (0.32em of an
 * 11 px font is 3.52 px), so they are moved onto the device pixel grid.
 */

/** How far `position` (CSS pixels) moves to land on the nearest device pixel at `ratio`. */
export function devicePixelShift(position: number, ratio: number): number {
  return Math.round(position * ratio) / ratio - position;
}

/** A length attribute (`x`, `y`, `dy`) in pixels: em lengths are in units of `fontSize`. */
export function lengthInPixels(value: string | null, fontSize: number): number {
  if (value === null || value === "") {
    return 0;
  }
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) {
    throw new Error(`Not a single SVG length: "${value}"`);
  }
  return value.endsWith("em") ? amount * fontSize : amount;
}

/** Where a run of `length` pixels starts, from its anchor point. */
export function runStart(anchor: number, length: number, textAnchor: string): number {
  if (textAnchor === "end") {
    return anchor - length;
  }
  return textAnchor === "middle" ? anchor - length / 2 : anchor;
}

/**
 * Shifts each text, by a `translate` of its own, so that the start of its
 * glyphs and its baseline fall on device pixels. Its `x`, `y` and `dy` stay
 * as d3 set them: an axis redrawn later keeps working, and the shift is
 * computed again from them. Texts in a rotated or skewed group are left
 * alone, as no translation puts them on the grid. Every text is measured
 * before any moves, so the layout is computed once, not once per text.
 */
export function snapTextsToDevicePixels(
  texts: Iterable<SVGTextElement>,
  ratio: number = window.devicePixelRatio,
): void {
  const shifts: { text: SVGTextElement; dx: number; dy: number }[] = [];
  for (const text of texts) {
    const parent = text.parentElement;
    if (!(parent instanceof SVGGraphicsElement)) {
      throw new Error("A text to snap is not inside an SVG group");
    }
    const frame = parent.getScreenCTM();
    if (frame === null || frame.b !== 0 || frame.c !== 0) {
      continue;
    }
    const style = getComputedStyle(text);
    const fontSize = Number.parseFloat(style.fontSize);
    const anchor = lengthInPixels(text.getAttribute("x"), fontSize);
    const baseline =
      lengthInPixels(text.getAttribute("y"), fontSize) +
      lengthInPixels(text.getAttribute("dy"), fontSize);
    const start = runStart(anchor, text.getComputedTextLength(), style.textAnchor);
    shifts.push({
      text,
      dx: devicePixelShift(frame.e + start * frame.a, ratio) / frame.a,
      dy: devicePixelShift(frame.f + baseline * frame.d, ratio) / frame.d,
    });
  }
  for (const { text, dx, dy } of shifts) {
    text.setAttribute("transform", `translate(${dx.toFixed(3)},${dy.toFixed(3)})`);
  }
}
