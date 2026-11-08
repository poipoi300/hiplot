/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { PixelSpan } from "./brushes";

/** Size of the value tags and the bounds they stay within, in pixels. */
export interface TagMetrics {
  /** Height of one tag. */
  height: number;
  /** Space between a tag and its brush edge, and between neighboring tags. */
  gap: number;
  /** Where the tags may go: the top of the highest tag and the bottom of the lowest. */
  min: number;
  max: number;
}

/** A brush to tag: its span, and whether it takes a single tag (see `TagTexts`). */
export interface TaggedSpan extends PixelSpan {
  single: boolean;
}

/**
 * What the tags of one brush read: the value at its top edge and the one at
 * its bottom edge, or a single text (bottom null) when both would name the
 * same category.
 */
export interface TagTexts {
  top: string;
  bottom: string | null;
}

/**
 * The tags of a categorical brush covering `categories`: the category drawn
 * highest and the one drawn lowest, by their `position` in axis pixels (so
 * the tags follow the axis however it is oriented); a single tag when the
 * brush covers one category, or none ("none").
 */
export function categoryTagTexts(
  categories: ReadonlyArray<string>,
  position: (category: string) => number,
): TagTexts {
  if (categories.length === 0) {
    return { top: "none", bottom: null };
  }
  const byPosition = [...categories].sort((a, b) => position(a) - position(b));
  const top = byPosition[0];
  const bottom = byPosition[byPosition.length - 1];
  return { top, bottom: categories.length === 1 ? null : bottom };
}

/** Where one value tag goes: the brush it labels (an index into the spans), its edge, its center. */
export interface PlacedTag {
  brush: number;
  edge: "top" | "bottom";
  center: number;
  /** Whether the tag sits inside its brush, for want of room outside. */
  inside: boolean;
}

/**
 * Places the value tags of the brushes on one axis. Each brush gets a tag at
 * its top edge and, unless it takes a single tag, one at its bottom edge,
 * outside the brush when there is
 * room, inside it when an axis end or a neighboring brush leaves none. Two
 * neighbors whose facing tags do not both fit between them take both inside.
 *
 * Tags never overlap: any that still collide (brushes too short to hold their
 * tags) are pushed apart, down first and then up from the bottom bound, in
 * the order of the brushes from the top. When the axis cannot hold every tag,
 * the tags of the lowest brushes are left out. The result depends only on the
 * spans, not on their order.
 */
export function placeBrushTags(spans: ReadonlyArray<TaggedSpan>, metrics: TagMetrics): PlacedTag[] {
  const { height, gap, min, max } = metrics;
  const step = height + gap;
  const order = spans
    .map((_span, index) => index)
    .sort((a, b) => spans[a].top - spans[b].top || spans[a].bottom - spans[b].bottom || a - b);
  const capacity = Math.max(0, Math.floor((max - min + gap) / step));
  const shown: number[] = [];
  let tagCount = 0;
  for (const brush of order) {
    tagCount += spans[brush].single ? 1 : 2;
    if (tagCount > capacity) {
      break;
    }
    shown.push(brush);
  }

  const tags: PlacedTag[] = [];
  shown.forEach((brush, rank) => {
    const { top, bottom } = spans[brush];
    const above = rank === 0 ? null : spans[shown[rank - 1]];
    const below = rank === shown.length - 1 ? null : spans[shown[rank + 1]];
    // Facing tags of two neighbors need two tags and three gaps between the brushes.
    const topOutside =
      above === null ? top - gap - height >= min : top - above.bottom >= 2 * height + 3 * gap;
    const bottomOutside =
      below === null ? bottom + gap + height <= max : below.top - bottom >= 2 * height + 3 * gap;
    tags.push({
      brush,
      edge: "top",
      center: topOutside ? top - gap - height / 2 : top + gap + height / 2,
      inside: !topOutside,
    });
    if (spans[brush].single) {
      return;
    }
    tags.push({
      brush,
      edge: "bottom",
      center: bottomOutside ? bottom + gap + height / 2 : bottom - gap - height / 2,
      inside: !bottomOutside,
    });
  });

  for (let i = 1; i < tags.length; ++i) {
    tags[i].center = Math.max(tags[i].center, tags[i - 1].center + step);
  }
  for (let i = tags.length - 1; i >= 0; --i) {
    const limit = i === tags.length - 1 ? max - height / 2 : tags[i + 1].center - step;
    tags[i].center = Math.min(tags[i].center, limit);
  }
  for (let i = 0; i < tags.length; ++i) {
    const limit = i === 0 ? min + height / 2 : tags[i - 1].center + step;
    tags[i].center = Math.max(tags[i].center, limit);
  }
  return tags;
}
