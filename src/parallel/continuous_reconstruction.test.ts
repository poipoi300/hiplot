import { describe, expect, test } from "bun:test";
import type { ContinuousPairImage } from "./continuous_density";
import {
  continuousReconstructionPlan,
  reconstructContinuousPair,
} from "./continuous_reconstruction";
import type { ContinuousHistogram } from "./continuous_types";

type Cell = readonly [left: number, right: number, selected?: number];

function histogram(cells: readonly Cell[], bins = 17): ContinuousHistogram {
  const size = (bins + 1) ** 2;
  const result: ContinuousHistogram = {
    bins,
    selected: new Uint32Array(size),
    context: new Uint32Array(size),
    color0: new Float64Array(size),
    color1: new Float64Array(size),
    color2: new Float64Array(size),
    minimum: new Uint32Array(size),
    maximum: new Uint32Array(size),
    occupied: new Uint32Array(cells.length),
    revision: 1,
  };
  cells.forEach(([left, right, selected = 1], index) => {
    const cell = left * (bins + 1) + right;
    result.occupied[index] = cell;
    result.selected[cell] = selected;
    result.context[cell] = 1;
  });
  return result;
}

function ramp(width = 2, height = 16): ContinuousPairImage {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const offset = (y * width + x) * 4;
      pixels.set([y * 10, y * 10, y * 10, 255], offset);
    }
  }
  return { pixels, width, height };
}

type Bounds = (t: number) => readonly [number, number];

/** A row ramp exposes the inverse warp directly, independently of image sampling. */
function expectRampMapping(
  result: ContinuousPairImage,
  sourceWidth: number,
  bounds: Bounds,
  height = 16,
): void {
  for (let x = 0; x < result.width; ++x) {
    const sourceX = Math.max(
      0,
      Math.min(sourceWidth - 1, ((x + 0.5) * sourceWidth) / result.width - 0.5),
    );
    const first = Math.floor(sourceX);
    const second = Math.min(first + 1, sourceWidth - 1);
    const fraction = sourceX - first;
    const [low, high] = bounds((x + 0.5) / result.width);
    for (let y = 0; y < height; ++y) {
      const values = [
        Math.max(0, first - 1),
        first,
        second,
        Math.min(sourceWidth - 1, second + 1),
      ].map((column) => {
        const [sourceLow, sourceHigh] = bounds((column + 0.5) / sourceWidth);
        const center = y + 0.5;
        let mapped: number;
        if (!Number.isFinite(low) || !Number.isFinite(sourceLow)) mapped = center;
        else if (sourceHigh - sourceLow <= 1)
          mapped = center + (sourceLow + sourceHigh - low - high) / 2;
        else if (center < low) mapped = (center * sourceLow) / low;
        else if (center > high)
          mapped = sourceHigh + ((center - high) * (height - sourceHigh)) / (height - high);
        else
          mapped =
            high === low
              ? (sourceLow + sourceHigh) / 2
              : sourceLow + ((center - low) * (sourceHigh - sourceLow)) / (high - low);
        const position = mapped - 0.5;
        const top = Math.floor(position);
        const bottom = top + 1;
        const vertical = position - top;
        const topWeight = top >= 0 && top < height ? 1 - vertical : 0;
        const bottomWeight = bottom >= 0 && bottom < height ? vertical : 0;
        return [(top * topWeight + bottom * bottomWeight) * 10, topWeight + bottomWeight];
      });
      const cubicAvailable =
        sourceWidth >= 4 &&
        Number.isFinite(low) &&
        [Math.max(0, first - 1), first, second, Math.min(sourceWidth - 1, second + 1)].every(
          (column) => Number.isFinite(bounds((column + 0.5) / sourceWidth)[0]),
        );
      const interpolate = (channel: number): number => {
        const [a, b, c, d] = values.map((value) => value[channel]);
        if (!cubicAvailable) return b * (1 - fraction) + c * fraction;
        const cubic =
          0.5 *
          (2 * b +
            (-a + c) * fraction +
            (2 * a - 5 * b + 4 * c - d) * fraction ** 2 +
            (-a + 3 * b - 3 * c + d) * fraction ** 3);
        return Math.max(Math.min(b, c), Math.min(Math.max(b, c), cubic));
      };
      const alpha = interpolate(1);
      const linearAlpha = values[1][1] * (1 - fraction) + values[2][1] * fraction;
      const color = values[1][0] * (1 - fraction) + values[2][0] * fraction;
      const expected = new Uint8ClampedArray([
        linearAlpha > 0 ? color / linearAlpha : 0,
        alpha * 255,
      ]);
      const offset = (y * result.width + x) * 4;
      expect(result.pixels[offset]).toBe(expected[0]);
      expect(result.pixels[offset + 3]).toBe(expected[1]);
    }
  }
}

describe("continuous pair reconstruction", () => {
  test("stationary and subpixel envelopes retain inexpensive linear reconstruction", () => {
    for (const cells of [
      [
        [0, 0],
        [16, 16],
      ],
      [
        [2, 2],
        [6, 6],
      ],
      [[7, 8]],
      [],
    ] as readonly (readonly Cell[])[]) {
      expect(
        continuousReconstructionPlan(histogram(cells), { height: 16, curved: true }, 80, 5),
      ).toBeNull();
    }
  });

  test("moving selected or independent context support receives a shared transport plan", () => {
    const counts = histogram([
      [4, 4],
      [0, 16, 0],
    ]);
    const frame = { height: 16, curved: false };
    const plan = continuousReconstructionPlan(counts, frame, 80, 5);
    expect(plan).not.toBeNull();
    if (plan === null) throw new Error("Missing moving-context plan");
    expect(plan.selected.lower.length).toBe(85);
    expect(Array.from(plan.selected.lower)).toEqual(Array(85).fill(4));
    const image = { ...ramp(5), contextPixels: ramp(5).pixels };
    expect(reconstructContinuousPair(image, counts, frame, 80, plan).pixels).toEqual(
      reconstructContinuousPair(image, counts, frame, 80).pixels,
    );
    expect(
      continuousReconstructionPlan(
        histogram([
          [0, 16],
          [16, 0],
        ]),
        frame,
        80,
        5,
      ),
    ).not.toBeNull();
  });

  test("full-resolution images retain their object and pixel identity", () => {
    const image = ramp(8);
    expect(
      reconstructContinuousPair(image, histogram([]), { height: 16, curved: false }, 7.2),
    ).toBe(image);
  });

  test("independent layers composite selected over context without mutating the sources", () => {
    const image: ContinuousPairImage = {
      pixels: new Uint8ClampedArray([255, 0, 0, 128]),
      contextPixels: new Uint8ClampedArray([0, 255, 0, 128]),
      width: 1,
      height: 1,
    };
    const result = reconstructContinuousPair(
      image,
      histogram([[0, 0]]),
      { height: 1, curved: false },
      1,
    );
    expect(Array.from(result.pixels)).toEqual([170, 85, 0, 192]);
    expect(result.contextPixels).toBeUndefined();
    expect(Array.from(image.pixels)).toEqual([255, 0, 0, 128]);
    expect(Array.from(image.contextPixels ?? [])).toEqual([0, 255, 0, 128]);
  });

  test("flat guides preserve every row and centered horizontal interpolation", () => {
    const image = ramp();
    for (let y = 0; y < image.height; ++y) image.pixels[(y * 2 + 1) * 4] += 40;
    const result = reconstructContinuousPair(
      image,
      histogram([
        [2, 2],
        [12, 12],
      ]),
      { height: 16, curved: false },
      7.2,
    );
    expect(result.width).toBe(8);
    expect(result.height).toBe(16);
    for (let x = 0; x < 8; ++x) {
      const fraction = Math.max(0, Math.min(1, ((x + 0.5) * 2) / 8 - 0.5));
      for (let y = 0; y < 16; ++y) {
        expect(result.pixels[(y * 8 + x) * 4]).toBe(
          new Uint8ClampedArray([y * 10 + fraction * 40])[0],
        );
      }
    }
  });

  for (const curved of [false, true]) {
    test(`wedge support follows ${curved ? "eased" : "straight"} endpoint movement`, () => {
      const result = reconstructContinuousPair(
        ramp(),
        histogram([
          [2, 10],
          [6, 10],
          [0, 16, 0],
        ]),
        { height: 16, curved },
        8,
      );
      expectRampMapping(result, 2, (t) => {
        const w = curved ? t * t * (3 - 2 * t) : t;
        return [2 + 8 * w, 6 + 4 * w];
      });
    });

    test(`correlated support does not invent Cartesian endpoint combinations (${curved})`, () => {
      const result = reconstructContinuousPair(
        ramp(),
        histogram([
          [0, 16],
          [16, 0],
        ]),
        { height: 16, curved },
        8,
      );
      expectRampMapping(result, 2, (t) => {
        const w = curved ? t * t * (3 - 2 * t) : t;
        return [16 * Math.min(w, 1 - w), 16 * Math.max(w, 1 - w)];
      });
    });
  }

  test("transparent colored pixels cannot tint horizontal or vertical interpolation", () => {
    const image = ramp(6);
    for (let offset = 0; offset < image.pixels.length; offset += 4)
      image.pixels.set([0, 255, 255, 0], offset);
    image.pixels.set([255, 0, 0, 255], 6 * image.width * 4);
    const result = reconstructContinuousPair(
      image,
      histogram([
        [2, 10],
        [6, 10],
      ]),
      { height: 16, curved: false },
      8,
    );
    let mixed = 0;
    for (let offset = 0; offset < result.pixels.length; offset += 4) {
      const alpha = result.pixels[offset + 3];
      if (alpha > 0) {
        expect(Array.from(result.pixels.slice(offset, offset + 3))).toEqual([255, 0, 0]);
        if (alpha < 255) mixed++;
      } else expect(Array.from(result.pixels.slice(offset, offset + 4))).toEqual([0, 0, 0, 0]);
    }
    expect(mixed).toBeGreaterThan(0);
  });

  test("cubic opacity follows smooth profiles without ringing past adjacent samples", () => {
    const image = ramp(6);
    const values = [0, 40, 180, 210, 240, 250];
    for (let y = 0; y < image.height; ++y) {
      for (let x = 0; x < image.width; ++x)
        image.pixels.set([128, 128, 128, values[x]], (y * image.width + x) * 4);
    }
    const result = reconstructContinuousPair(
      image,
      histogram([
        [0, 0],
        [16, 16],
      ]),
      { height: 16, curved: false },
      96,
    );
    let differsFromLinear = false;
    for (let x = 0; x < result.width; ++x) {
      const source = Math.max(0, Math.min(5, ((x + 0.5) * 6) / 96 - 0.5));
      const below = Math.floor(source);
      const above = Math.min(5, below + 1);
      const value = result.pixels[x * 4 + 3];
      const fraction = source - below;
      const linear = new Uint8ClampedArray([
        values[below] * (1 - fraction) + values[above] * fraction,
      ])[0];
      expect(value).toBeGreaterThanOrEqual(Math.min(values[below], values[above]));
      expect(value).toBeLessThanOrEqual(Math.max(values[below], values[above]));
      differsFromLinear ||= value !== linear;
    }
    expect(differsFromLinear).toBe(true);
  });

  test("varying alpha cannot create a new straight-color extremum", () => {
    const pixels = new Uint8ClampedArray([
      0, 0, 0, 255, 128, 0, 0, 64, 128, 0, 0, 128, 0, 0, 0, 255,
    ]);
    const result = reconstructContinuousPair(
      { pixels, width: 4, height: 1 },
      histogram([
        [0, 0],
        [16, 16],
      ]),
      { height: 1, curved: false },
      9,
    );
    expect(result.pixels[4 * 4]).toBe(128);
  });

  test("context-only and both-missing cells fall back to centered linear reconstruction", () => {
    const image = ramp();
    for (let y = 0; y < 16; ++y) image.pixels[(y * 2 + 1) * 4] += 40;
    const result = reconstructContinuousPair(
      image,
      histogram([
        [0, 16, 0],
        [17, 17],
      ]),
      { height: 16, curved: true },
      8,
    );
    for (let x = 0; x < 8; ++x) {
      const fraction = Math.max(0, Math.min(1, ((x + 0.5) * 2) / 8 - 0.5));
      for (let y = 0; y < 16; ++y)
        expect(result.pixels[(y * 8 + x) * 4]).toBe(
          new Uint8ClampedArray([y * 10 + fraction * 40])[0],
        );
    }
  });

  test("collapsed moving support remains finite, including an exact destination anchor", () => {
    const result = reconstructContinuousPair(
      ramp(),
      histogram([[0, 16]]),
      { height: 16, curved: false },
      16,
    );
    expectRampMapping(result, 2, (t) => [16 * t, 16 * t]);
  });

  test("support touching both frame edges preserves the row ramp", () => {
    const result = reconstructContinuousPair(
      ramp(),
      histogram([
        [0, 0],
        [16, 16],
      ]),
      { height: 16, curved: true },
      8,
    );
    expectRampMapping(result, 2, () => [0, 16]);
  });

  test("fractional-height flat guides preserve the partially covered final pixel", () => {
    const image = ramp();
    const result = reconstructContinuousPair(
      image,
      histogram([
        [0, 0],
        [16, 16],
      ]),
      { height: 15.25, curved: false },
      8,
    );
    for (let x = 0; x < result.width; ++x)
      expect(result.pixels[(15 * result.width + x) * 4]).toBe(150);
  });

  test("selected missing endpoints extend guides only inside their 15px stubs", () => {
    const result = reconstructContinuousPair(
      ramp(4),
      histogram([
        [4, 8],
        [8, 12],
        [0, 17],
        [17, 16],
        [17, 17],
        [16, 17, 0],
      ]),
      { height: 16, curved: false },
      60,
    );
    expectRampMapping(result, 4, (t) => [
      t * 60 < 15 ? 0 : 4 + 4 * t,
      t * 60 >= 45 ? 16 : 8 + 4 * t,
    ]);
  });

  test("stub-only columns with no local support use the linear fallback", () => {
    const result = reconstructContinuousPair(
      ramp(4),
      histogram([
        [2, 17],
        [17, 14],
      ]),
      { height: 16, curved: true },
      60,
    );
    expectRampMapping(result, 4, (t) =>
      t * 60 < 15 ? [2, 2] : t * 60 >= 45 ? [14, 14] : [Infinity, -Infinity],
    );
  });

  test("fractional frame heights and large shear keep all output RGBA bounded", () => {
    const image = ramp(3);
    for (let offset = 0; offset < image.pixels.length; ++offset)
      image.pixels[offset] = (offset * 73) % 256;
    const result = reconstructContinuousPair(
      image,
      histogram([
        [0, 16],
        [1, 15],
      ]),
      { height: 15.25, curved: true },
      31.2,
    );
    expect(result.pixels.length).toBe(32 * 16 * 4);
    expect(result.pixels.some((value) => value > 0)).toBe(true);
    for (const value of result.pixels) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(255);
    }
  });
});
