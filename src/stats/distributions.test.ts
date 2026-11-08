import { describe, expect, test } from "bun:test";
import {
  type DistributionFamily,
  type FittedDistribution,
  fitDistributions,
  formatParameter,
  kernelDensity,
} from "./distributions";
import { digamma, logGamma } from "./special";

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic sampler with standard normal, exponential and integer-shape gamma draws. */
function sampler(seed: number) {
  const uniform = mulberry32(seed);
  const open = () => 1 - uniform();
  const normal = () => Math.sqrt(-2 * Math.log(open())) * Math.cos(2 * Math.PI * uniform());
  const exponential = () => -Math.log(open());
  const gamma = (integerShape: number) => {
    let sum = 0;
    for (let draw = 0; draw < integerShape; ++draw) {
      sum += exponential();
    }
    return sum;
  };
  return { normal, exponential, gamma };
}

function draw(count: number, generate: () => number): number[] {
  return Array.from({ length: count }, generate);
}

function candidate(family: DistributionFamily, fits: FittedDistribution[]): FittedDistribution {
  const found = fits.find((fit) => fit.family === family);
  if (found === undefined) {
    throw new Error(`no ${family} candidate among ${fits.map((fit) => fit.family).join(", ")}`);
  }
  return found;
}

function families(values: number[]): DistributionFamily[] {
  return fitDistributions(values)
    .candidates.map((fit) => fit.family)
    .sort();
}

describe("formatParameter", () => {
  test("it keeps three significant digits and trims trailing zeros", () => {
    expect(formatParameter(0.42)).toBe("0.42");
    expect(formatParameter(0.1)).toBe("0.1");
    expect(formatParameter(2)).toBe("2");
    expect(formatParameter(Math.PI)).toBe("3.14");
    expect(formatParameter(12345.6)).toBe("12300");
    expect(formatParameter(-0.001234)).toBe("-0.00123");
  });

  test("magnitudes below 1e-3 or from 1e5 on use scientific notation", () => {
    expect(formatParameter(0.000012)).toBe("1.2e-5");
    expect(formatParameter(0.0001234)).toBe("1.23e-4");
    expect(formatParameter(123456)).toBe("1.23e5");
    expect(formatParameter(100000)).toBe("1e5");
    expect(formatParameter(-2.5e-7)).toBe("-2.5e-7");
  });

  test("zero and non-finite values print plainly", () => {
    expect(formatParameter(0)).toBe("0");
    expect(formatParameter(Number.NaN)).toBe("NaN");
    expect(formatParameter(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });
});

describe("fitDistributions on closed-form cases", () => {
  test("the normal MLE uses the 1/n standard deviation", () => {
    const normal = candidate("normal", fitDistributions([1, 2, 3, 4, 5]).candidates);
    expect(normal.parameters.mu).toBe(3);
    expect(normal.parameters.sigma).toBeCloseTo(Math.SQRT2, 12);
    expect(normal.parameterCount).toBe(2);
    expect(normal.label).toBe("N(μ=3, σ=1.41)");
    expect(normal.logLikelihood).toBeCloseTo(
      -5 * (Math.log(Math.SQRT2) + 0.5 * Math.log(2 * Math.PI) + 0.5),
      12,
    );
    expect(normal.pdf(3)).toBeCloseTo(1 / (Math.SQRT2 * Math.sqrt(2 * Math.PI)), 12);
  });

  test("the exponential rate is the reciprocal of the mean", () => {
    const exponential = candidate("exponential", fitDistributions([1, 2, 3]).candidates);
    expect(exponential.parameters.rate).toBeCloseTo(0.5, 12);
    expect(exponential.parameterCount).toBe(1);
    expect(exponential.logLikelihood).toBeCloseTo(3 * Math.log(0.5) - 3, 12);
    expect(exponential.label).toBe("Exp(λ=0.5)");
    expect(exponential.pdf(-1)).toBe(0);
  });

  test("the information criteria follow AIC = 2k - 2lnL and BIC = k ln n - 2lnL", () => {
    const values = [1, 2, 3, 4, 7, 11];
    for (const fit of fitDistributions(values).candidates) {
      expect(fit.aic).toBeCloseTo(2 * fit.parameterCount - 2 * fit.logLikelihood, 10);
      expect(fit.bic).toBeCloseTo(
        fit.parameterCount * Math.log(values.length) - 2 * fit.logLikelihood,
        10,
      );
    }
  });

  test("the lognormal MLE is the normal MLE of the logs", () => {
    const values = [1, Math.E, Math.E ** 2];
    const lognormal = candidate("lognormal", fitDistributions(values).candidates);
    expect(lognormal.parameters.mu).toBeCloseTo(1, 12);
    expect(lognormal.parameters.sigma).toBeCloseTo(Math.sqrt(2 / 3), 12);
    expect(lognormal.pdf(0)).toBe(0);
    expect(lognormal.label).toBe("LogNormal(μ=1, σ=0.816)");
  });

  test("the gamma shape solves ln k - digamma(k) = ln(mean) - mean(ln x)", () => {
    const values = [0.5, 1, 1.5, 2.5, 4, 7];
    const gamma = candidate("gamma", fitDistributions(values).candidates);
    const { shape, rate } = gamma.parameters;
    const meanValue = values.reduce((sum, value) => sum + value, 0) / values.length;
    const meanLog = values.reduce((sum, value) => sum + Math.log(value), 0) / values.length;
    expect(Math.log(shape) - digamma(shape)).toBeCloseTo(Math.log(meanValue) - meanLog, 10);
    expect(shape / rate).toBeCloseTo(meanValue, 12);
    expect(gamma.label).toBe(`Gamma(k=${shape.toPrecision(3)}, θ=${(1 / rate).toPrecision(3)})`);
  });
});

describe("fitDistributions support and ranking", () => {
  test("candidates follow the support of the sample", () => {
    expect(families([-1, 0, 2, 3, 5])).toEqual(["normal", "student-t"]);
    expect(families([1, 2, 3, 6])).toEqual([
      "exponential",
      "gamma",
      "lognormal",
      "normal",
      "student-t",
    ]);
    expect(families([0.1, 0.4, 0.5, 0.8])).toEqual([
      "beta",
      "exponential",
      "gamma",
      "lognormal",
      "normal",
      "student-t",
    ]);
    expect(families([0.1, 0.4, 1, 3])).not.toContain("beta");
    expect(families([0, 1, 2, 5])).not.toContain("lognormal");
  });

  test("candidates are sorted by BIC and the best is the first", () => {
    const { normal } = sampler(7);
    const fits = fitDistributions(draw(300, () => 10 + 2 * normal()));
    const bics = fits.candidates.map((fit) => fit.bic);
    expect(bics).toEqual([...bics].sort((a, b) => a - b));
    expect(fits.best).toBe(fits.candidates[0]);
    expect(fits.criterion).toBe("BIC");
  });

  test("non-finite values are ignored", () => {
    const withJunk = fitDistributions([1, 2, Number.NaN, 3, Number.POSITIVE_INFINITY, 4, 5]);
    const clean = fitDistributions([1, 2, 3, 4, 5]);
    expect(candidate("normal", withJunk.candidates).parameters).toEqual(
      candidate("normal", clean.candidates).parameters,
    );
  });

  test("too few values or no spread give no fit", () => {
    const none = { candidates: [], best: null, criterion: "BIC" as const };
    expect(fitDistributions([])).toEqual(none);
    expect(fitDistributions([1, 2])).toEqual(none);
    expect(fitDistributions([4, 4, 4, 4])).toEqual(none);
    expect(fitDistributions([Number.NaN, 1, 2, Number.NaN])).toEqual(none);
  });
});

describe("fitDistributions recovers generating distributions", () => {
  test("normal data picks the normal, or a t that is almost normal", () => {
    const { normal } = sampler(11);
    const values = draw(2000, () => 5 + 2 * normal());
    const fits = fitDistributions(values);
    const fitted = candidate("normal", fits.candidates);
    expect(fitted.parameters.mu).toBeCloseTo(5, 1);
    expect(fitted.parameters.sigma).toBeCloseTo(2, 1);
    const truth = (x: number) => Math.exp(-0.5 * ((x - 5) / 2) ** 2) / (2 * Math.sqrt(2 * Math.PI));
    expect(fits.best?.pdf(5) ?? 0).toBeCloseTo(truth(5), 1);
    expect(fits.best?.pdf(8) ?? 0).toBeCloseTo(truth(8), 1);
    expect(["normal", "student-t"]).toContain(fits.best?.family ?? "");
  });

  test("exponential data picks the exponential or a gamma with shape near 1", () => {
    const { exponential } = sampler(23);
    const values = draw(2000, () => exponential() / 0.5);
    const fits = fitDistributions(values);
    expect(["exponential", "gamma"]).toContain(fits.best?.family ?? "");
    expect(candidate("exponential", fits.candidates).parameters.rate).toBeCloseTo(0.5, 1);
    expect(candidate("gamma", fits.candidates).parameters.shape).toBeCloseTo(1, 0);
  });

  test("gamma data picks the gamma and recovers shape and rate", () => {
    const { gamma } = sampler(31);
    const values = draw(3000, () => gamma(3) * 2);
    const fits = fitDistributions(values);
    expect(fits.best?.family).toBe("gamma");
    expect(fits.best?.parameters.shape).toBeCloseTo(3, 0);
    expect(fits.best?.parameters.rate).toBeCloseTo(0.5, 1);
  });

  test("lognormal data picks the lognormal and recovers mu and sigma", () => {
    const { normal } = sampler(41);
    const values = draw(3000, () => Math.exp(1 + 0.8 * normal()));
    const fits = fitDistributions(values);
    expect(fits.best?.family).toBe("lognormal");
    expect(fits.best?.parameters.mu).toBeCloseTo(1, 1);
    expect(fits.best?.parameters.sigma).toBeCloseTo(0.8, 1);
  });

  test("data in (0, 1) from Beta(2, 5) includes a beta fit that recovers both shapes", () => {
    const { gamma } = sampler(53);
    const values = draw(4000, () => {
      const left = gamma(2);
      return left / (left + gamma(5));
    });
    const fits = fitDistributions(values);
    const beta = candidate("beta", fits.candidates);
    expect(beta.parameters.alpha).toBeGreaterThan(1.85);
    expect(beta.parameters.alpha).toBeLessThan(2.15);
    expect(beta.parameters.beta).toBeGreaterThan(4.6);
    expect(beta.parameters.beta).toBeLessThan(5.4);
    expect(fits.best?.family).toBe("beta");
    expect(beta.label).toBe(
      `Beta(α=${beta.parameters.alpha.toPrecision(3)}, β=${beta.parameters.beta.toPrecision(3)})`,
    );
    expect(beta.pdf(0)).toBe(0);
    expect(beta.pdf(1)).toBe(0);
  });

  test("the beta fit maximizes the likelihood against nearby parameters", () => {
    const { gamma } = sampler(59);
    const values = draw(500, () => {
      const left = gamma(3);
      return left / (left + gamma(2));
    });
    const beta = candidate("beta", fitDistributions(values).candidates);
    const logLikelihoodAt = (alpha: number, betaShape: number) =>
      values.reduce(
        (sum, x) =>
          sum +
          logGamma(alpha + betaShape) -
          logGamma(alpha) -
          logGamma(betaShape) +
          (alpha - 1) * Math.log(x) +
          (betaShape - 1) * Math.log1p(-x),
        0,
      );
    const { alpha, beta: betaShape } = beta.parameters;
    expect(beta.logLikelihood).toBeCloseTo(logLikelihoodAt(alpha, betaShape), 8);
    for (const [deltaAlpha, deltaBeta] of [
      [0.05, 0],
      [-0.05, 0],
      [0, 0.05],
      [0, -0.05],
    ]) {
      expect(logLikelihoodAt(alpha + deltaAlpha, betaShape + deltaBeta)).toBeLessThan(
        beta.logLikelihood,
      );
    }
  });

  test("heavy-tailed data picks the Student-t and recovers location, scale and dof", () => {
    const { normal } = sampler(67);
    const values = draw(3000, () => {
      const chiSquared = normal() ** 2 + normal() ** 2 + normal() ** 2;
      return 10 + 2 * (normal() / Math.sqrt(chiSquared / 3));
    });
    const fits = fitDistributions(values);
    expect(fits.best?.family).toBe("student-t");
    const { mu, sigma, nu } = fits.best?.parameters ?? {};
    expect(mu).toBeCloseTo(10, 0);
    expect(sigma).toBeGreaterThan(1.8);
    expect(sigma).toBeLessThan(2.2);
    expect(nu).toBeGreaterThan(2.2);
    expect(nu).toBeLessThan(4.2);
    expect(fits.best?.parameterCount).toBe(3);
  });

  test("the Student-t fit maximizes the likelihood against nearby parameters", () => {
    const { normal } = sampler(71);
    const values = draw(400, () => {
      const chiSquared =
        normal() ** 2 + normal() ** 2 + normal() ** 2 + normal() ** 2 + normal() ** 2;
      return normal() / Math.sqrt(chiSquared / 5);
    });
    const fitted = candidate("student-t", fitDistributions(values).candidates);
    const { mu, sigma, nu } = fitted.parameters;
    const logLikelihoodAt = (location: number, scale: number, dof: number) =>
      values.reduce(
        (sum, x) =>
          sum +
          logGamma((dof + 1) / 2) -
          logGamma(dof / 2) -
          0.5 * Math.log(dof * Math.PI) -
          Math.log(scale) -
          ((dof + 1) / 2) * Math.log1p(((x - location) / scale) ** 2 / dof),
        0,
      );
    expect(fitted.logLikelihood).toBeCloseTo(logLikelihoodAt(mu, sigma, nu), 8);
    for (const [locationFactor, scaleFactor, dofFactor] of [
      [0.02, 1, 1],
      [-0.02, 1, 1],
      [0, 1.02, 1],
      [0, 0.98, 1],
      [0, 1, 1.05],
      [0, 1, 0.95],
    ]) {
      expect(
        logLikelihoodAt(mu + locationFactor, sigma * scaleFactor, nu * dofFactor),
      ).toBeLessThan(fitted.logLikelihood);
    }
    expect(fitted.label).toBe(
      `t(μ=${formatParameter(mu)}, σ=${formatParameter(sigma)}, ν=${formatParameter(nu)})`,
    );
  });

  test("every candidate carries its density formula", () => {
    const { gamma } = sampler(5);
    const fits = fitDistributions(draw(50, () => gamma(2) / 10));
    expect(fits.candidates).toHaveLength(6);
    for (const fit of fits.candidates) {
      expect(fit.formula.startsWith("f(x) = ")).toBe(true);
      expect(fit.formula).not.toContain("-");
    }
  });
});

describe("kernelDensity", () => {
  test("the bandwidth is Silverman's rule of thumb", () => {
    const density = kernelDensity([-1, 0, 1]);
    // sd = 1, IQR = 1 with linear-interpolated quartiles.
    expect(density?.bandwidth).toBeCloseTo(0.9 * (1 / 1.34) * 3 ** -0.2, 12);
  });

  test("the density integrates to one and peaks inside a cluster", () => {
    const { normal } = sampler(3);
    const density = kernelDensity(draw(300, normal));
    if (density === null) {
      throw new Error("expected a density");
    }
    let area = 0;
    const step = 0.02;
    for (let x = -6; x <= 6; x += step) {
      area += density.pdf(x) * step;
    }
    expect(area).toBeCloseTo(1, 2);
    expect(density.pdf(0)).toBeGreaterThan(density.pdf(3));
  });

  test("two values give the average of two Gaussian kernels", () => {
    const density = kernelDensity([0, 2]);
    if (density === null) {
      throw new Error("expected a density");
    }
    const kernel = (x: number, center: number) =>
      Math.exp(-0.5 * ((x - center) / density.bandwidth) ** 2) /
      (density.bandwidth * Math.sqrt(2 * Math.PI));
    expect(density.pdf(1)).toBeCloseTo((kernel(1, 0) + kernel(1, 2)) / 2, 12);
  });

  test("fewer than two finite values, no spread, or a zero IQR give null", () => {
    expect(kernelDensity([])).toBeNull();
    expect(kernelDensity([3])).toBeNull();
    expect(kernelDensity([Number.NaN, 3])).toBeNull();
    expect(kernelDensity([2, 2, 2])).toBeNull();
    expect(kernelDensity([1, 1, 1, 1, 9])).toBeNull();
  });
});
