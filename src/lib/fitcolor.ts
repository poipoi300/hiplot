/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import type { ColorTheme, RGB } from "./colors";

/**
 * Colors a fit can take: strong hues around the wheel, light and dark
 * variants, so one of them is far from any color map or category palette.
 */
const CANDIDATES = [
  "#e8336d",
  "#ff5a1f",
  "#f2a900",
  "#2bb24c",
  "#00b8d9",
  "#3d6bff",
  "#9b4dff",
  "#ff4fd8",
  "#b3125a",
  "#0b7a75",
  "#7a2fd0",
  "#ff9e7a",
] as const;

/** The page backgrounds, as global.css sets --hip-bg. */
const BACKGROUNDS: { [theme in ColorTheme]: string } = { light: "#f8f8f6", dark: "#15181c" };
/** A fit line must stand out from the background at least this much (WCAG non-text contrast). */
const MIN_CONTRAST = 3;

function relativeLuminance(color: string): number {
  const { r, g, b } = d3.rgb(color);
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Perceptual distance between two colors (CIE76 ΔE in Lab). */
function labDistance(a: string, b: RGB): number {
  const first = d3.lab(a);
  const second = d3.lab(d3.rgb(b.r, b.g, b.b));
  return Math.hypot(first.l - second.l, first.a - second.a, first.b - second.b);
}

/**
 * The color fits are drawn in: of the candidates that stand out from the
 * theme's background, the one furthest (in Lab) from every color the data
 * is drawn in, so a fit never reads as data.
 */
export function fitColor(palette: ReadonlyArray<RGB>, theme: ColorTheme): string {
  const background = BACKGROUNDS[theme];
  const legible = CANDIDATES.filter((color) => contrastRatio(color, background) >= MIN_CONTRAST);
  let best: string = legible[0] ?? CANDIDATES[0];
  let bestDistance = Number.NEGATIVE_INFINITY;
  for (const color of legible) {
    const nearest = palette.reduce(
      (closest, rgb) => Math.min(closest, labDistance(color, rgb)),
      Number.POSITIVE_INFINITY,
    );
    if (nearest > bestDistance) {
      best = color;
      bestDistance = nearest;
    }
  }
  return best;
}
