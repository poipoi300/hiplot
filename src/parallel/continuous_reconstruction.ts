import type { ContinuousPairImage } from "./continuous_density";
import type { ContinuousHistogram, ContinuousRequest } from "./continuous_types";

export interface ContinuousSupport {
  lower: Float64Array;
  upper: Float64Array;
}

export interface ContinuousReconstructionPlan {
  selected: ContinuousSupport;
  context: ContinuousSupport;
}

/** Actual-cell support for source columns followed by full-width destination columns. */
export function continuousSupport(
  histogram: ContinuousHistogram,
  counts: Uint32Array,
  frame: Pick<ContinuousRequest, "height" | "curved">,
  gap: number,
  sourceWidth: number,
): ContinuousSupport {
  const { bins } = histogram;
  const width = Math.ceil(gap);
  if (counts[0] > 0 && counts[(bins - 1) * (bins + 2)] > 0)
    return {
      lower: new Float64Array(sourceWidth + width),
      upper: new Float64Array(sourceWidth + width).fill(frame.height),
    };
  const stride = bins + 1;
  const minimumRight = new Int32Array(bins).fill(bins);
  const maximumRight = new Int32Array(bins).fill(-1);
  let leftStubLower = bins;
  let leftStubUpper = -1;
  let rightStubLower = bins;
  let rightStubUpper = -1;
  for (const cell of histogram.occupied) {
    if (counts[cell] <= 0) continue;
    const left = Math.floor(cell / stride);
    const right = cell % stride;
    if (left === bins && right === bins) continue;
    if (left === bins) {
      rightStubLower = Math.min(rightStubLower, right);
      rightStubUpper = Math.max(rightStubUpper, right);
    } else if (right === bins) {
      leftStubLower = Math.min(leftStubLower, left);
      leftStubUpper = Math.max(leftStubUpper, left);
    } else {
      minimumRight[left] = Math.min(minimumRight[left], right);
      maximumRight[left] = Math.max(maximumRight[left], right);
    }
  }
  const lower = new Float64Array(sourceWidth + width);
  const upper = new Float64Array(lower.length);
  const spacing = frame.height / (bins - 1);
  for (let column = 0; column < lower.length; ++column) {
    const source = column < sourceWidth;
    const columns = source ? sourceWidth : width;
    const index = source ? column : column - sourceWidth;
    const t = (index + 0.5) / columns;
    const x = t * gap;
    const weight = frame.curved ? t * t * (3 - 2 * t) : t;
    let low = Infinity;
    let high = -Infinity;
    for (let left = 0; left < bins; ++left) {
      if (maximumRight[left] < 0) continue;
      low = Math.min(low, (1 - weight) * left + weight * minimumRight[left]);
      high = Math.max(high, (1 - weight) * left + weight * maximumRight[left]);
    }
    if (x < 15 && leftStubUpper >= 0) {
      low = Math.min(low, leftStubLower);
      high = Math.max(high, leftStubUpper);
    }
    if (x >= gap - 15 && rightStubUpper >= 0) {
      low = Math.min(low, rightStubLower);
      high = Math.max(high, rightStubUpper);
    }
    lower[column] = low * spacing;
    upper[column] = high * spacing;
  }
  return { lower, upper };
}

/** Reserve transport for resolvable envelope motion; aligned fields keep cheap linear blending. */
export function continuousReconstructionPlan(
  histogram: ContinuousHistogram,
  frame: Pick<ContinuousRequest, "height" | "curved">,
  gap: number,
  sourceWidth: number,
): ContinuousReconstructionPlan | null {
  const plan = {
    selected: continuousSupport(histogram, histogram.selected, frame, gap, sourceWidth),
    context: continuousSupport(histogram, histogram.context, frame, gap, sourceWidth),
  };
  for (const { lower, upper } of [plan.selected, plan.context]) {
    let minimumLower = Infinity;
    let maximumLower = -Infinity;
    let minimumUpper = Infinity;
    let maximumUpper = -Infinity;
    for (let column = 0; column < lower.length; ++column) {
      if (!Number.isFinite(lower[column])) continue;
      minimumLower = Math.min(minimumLower, lower[column]);
      maximumLower = Math.max(maximumLower, lower[column]);
      minimumUpper = Math.min(minimumUpper, upper[column]);
      maximumUpper = Math.max(maximumUpper, upper[column]);
    }
    if (maximumLower - minimumLower > 1 || maximumUpper - minimumUpper > 1) return plan;
  }
  return null;
}

/** Transport each independent density layer before selected-over-context compositing. */
export function reconstructContinuousPair(
  image: ContinuousPairImage,
  histogram: ContinuousHistogram,
  frame: Pick<ContinuousRequest, "height" | "curved">,
  gap: number,
  plan?: ContinuousReconstructionPlan,
): ContinuousPairImage {
  const selectedImage =
    image.contextPixels !== undefined && image.width === Math.ceil(gap)
      ? { pixels: image.pixels.slice(), width: image.width, height: image.height }
      : image;
  const selected = reconstructLayer(
    selectedImage,
    histogram,
    histogram.selected,
    frame,
    gap,
    plan?.selected,
  );
  if (image.contextPixels === undefined) return selected;
  const context = reconstructLayer(
    { pixels: image.contextPixels, width: image.width, height: image.height },
    histogram,
    histogram.context,
    frame,
    gap,
    plan?.context,
  );
  for (let offset = 0; offset < selected.pixels.length; offset += 4) {
    const selectedAlpha = selected.pixels[offset + 3] / 255;
    const contextShare = (context.pixels[offset + 3] / 255) * (1 - selectedAlpha);
    const alpha = selectedAlpha + contextShare;
    if (alpha <= 0) continue;
    for (let channel = 0; channel < 3; ++channel)
      selected.pixels[offset + channel] =
        (selected.pixels[offset + channel] * selectedAlpha +
          context.pixels[offset + channel] * contextShare) /
        alpha;
    selected.pixels[offset + 3] = alpha * 255;
  }
  return { pixels: selected.pixels, width: selected.width, height: selected.height };
}

function reconstructLayer(
  image: ContinuousPairImage,
  histogram: ContinuousHistogram,
  counts: Uint32Array,
  frame: Pick<ContinuousRequest, "height" | "curved">,
  gap: number,
  support?: ContinuousSupport,
): ContinuousPairImage {
  const width = Math.ceil(gap);
  if (image.width === width) return image;

  const { lower, upper } = support ?? continuousSupport(histogram, counts, frame, gap, image.width);

  const pixels = new Uint8ClampedArray(width * image.height * 4);
  // Each neighbor gets three affine maps, one per interval between guide anchors.
  const scales = new Float64Array(12);
  const offsets = new Float64Array(12);
  const neighbors = new Int32Array(4);
  const weights = new Float64Array(4);
  for (let x = 0; x < width; ++x) {
    const sourceX = Math.max(0, Math.min(image.width - 1, ((x + 0.5) * image.width) / width - 0.5));
    const below = Math.floor(sourceX);
    const above = Math.min(below + 1, image.width - 1);
    const fraction = sourceX - below;
    neighbors[0] = Math.max(0, below - 1);
    neighbors[1] = below;
    neighbors[2] = above;
    neighbors[3] = Math.min(image.width - 1, above + 1);
    const destinationLower = lower[image.width + x];
    const destinationUpper = upper[image.width + x];
    const cubic =
      image.width >= 4 &&
      Number.isFinite(destinationLower) &&
      neighbors.every((column) => Number.isFinite(lower[column]));
    const squared = fraction * fraction;
    const cubed = squared * fraction;
    weights[0] = cubic ? -0.5 * fraction + squared - 0.5 * cubed : 0;
    weights[1] = cubic ? 1 - 2.5 * squared + 1.5 * cubed : 1 - fraction;
    weights[2] = cubic ? 0.5 * fraction + 2 * squared - 1.5 * cubed : fraction;
    weights[3] = cubic ? -0.5 * squared + 0.5 * cubed : 0;
    for (let neighbor = 0; neighbor < 4; ++neighbor) {
      const column = neighbors[neighbor];
      const base = neighbor * 3;
      if (!Number.isFinite(destinationLower) || !Number.isFinite(lower[column])) {
        scales.fill(1, base, base + 3);
        offsets.fill(0, base, base + 3);
        continue;
      }
      // A subpixel source envelope has no resolved interior to stretch into a band.
      if (upper[column] - lower[column] <= 1) {
        scales.fill(1, base, base + 3);
        offsets.fill(
          (lower[column] + upper[column] - destinationLower - destinationUpper) / 2,
          base,
          base + 3,
        );
        continue;
      }
      scales[base] = destinationLower > 0 ? lower[column] / destinationLower : 0;
      offsets[base] = 0;
      const middleSpan = destinationUpper - destinationLower;
      scales[base + 1] = middleSpan > 0 ? (upper[column] - lower[column]) / middleSpan : 0;
      // A collapsed destination interval has one anchor, mapped to the source interval center.
      offsets[base + 1] =
        middleSpan > 0
          ? lower[column] - destinationLower * scales[base + 1]
          : (lower[column] + upper[column]) / 2;
      const lastSpan = frame.height - destinationUpper;
      scales[base + 2] = lastSpan > 0 ? (frame.height - upper[column]) / lastSpan : 1;
      offsets[base + 2] = upper[column] - destinationUpper * scales[base + 2];
    }
    for (let y = 0; y < image.height; ++y) {
      const center = y + 0.5;
      const interval = center < destinationLower ? 0 : center <= destinationUpper ? 1 : 2;
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      let minimumAlpha = Infinity;
      let maximumAlpha = -Infinity;
      let linearAlpha = 0;
      for (let neighbor = 0; neighbor < 4; ++neighbor) {
        if ((neighbor === 0 || neighbor === 3) && weights[neighbor] === 0) continue;
        const column = neighbors[neighbor];
        const mix = weights[neighbor];
        const map = neighbor * 3 + interval;
        const sourceY = center * scales[map] + offsets[map] - 0.5;
        const top = Math.floor(sourceY);
        const bottom = top + 1;
        const vertical = sourceY - top;
        const first = (Math.max(0, Math.min(image.height - 1, top)) * image.width + column) * 4;
        const second = (Math.max(0, Math.min(image.height - 1, bottom)) * image.width + column) * 4;
        // Replicating a clipped border pixel stretches its partial coverage into a false band.
        const firstAlpha =
          top >= 0 && top < image.height ? image.pixels[first + 3] * (1 - vertical) : 0;
        const secondAlpha =
          bottom >= 0 && bottom < image.height ? image.pixels[second + 3] * vertical : 0;
        const sampleAlpha = firstAlpha + secondAlpha;
        alpha += sampleAlpha * mix;
        if (neighbor === 1 || neighbor === 2) {
          const colorWeight = neighbor === 1 ? 1 - fraction : fraction;
          linearAlpha += sampleAlpha * colorWeight;
          red +=
            (image.pixels[first] * firstAlpha + image.pixels[second] * secondAlpha) * colorWeight;
          green +=
            (image.pixels[first + 1] * firstAlpha + image.pixels[second + 1] * secondAlpha) *
            colorWeight;
          blue +=
            (image.pixels[first + 2] * firstAlpha + image.pixels[second + 2] * secondAlpha) *
            colorWeight;
          minimumAlpha = Math.min(minimumAlpha, sampleAlpha);
          maximumAlpha = Math.max(maximumAlpha, sampleAlpha);
        }
      }
      // Bound opacity separately; convex premultiplied color cannot invent straight-color extrema.
      alpha = Math.max(minimumAlpha, Math.min(maximumAlpha, alpha));
      const destination = (y * width + x) * 4;
      if (alpha > 0 && linearAlpha > 0) {
        pixels[destination] = red / linearAlpha;
        pixels[destination + 1] = green / linearAlpha;
        pixels[destination + 2] = blue / linearAlpha;
        pixels[destination + 3] = alpha;
      }
    }
  }
  return { pixels, width, height: image.height };
}
