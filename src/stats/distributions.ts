/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Maximum-likelihood fits of candidate distributions to a sample, ranked by
 * BIC, and a Gaussian kernel density estimate. Work in whatever space the
 * caller hands in: for log-scale data, pass log-transformed values.
 */

import { finiteValues, mean } from "./finite";
import { digamma, logGamma, trigamma } from "./special";

export type DistributionFamily =
  | "normal"
  | "lognormal"
  | "exponential"
  | "gamma"
  | "beta"
  | "student-t";

export interface FittedDistribution {
  family: DistributionFamily;
  /** Named parameters, e.g. { mu, sigma } or { shape, rate }. */
  parameters: Readonly<Record<string, number>>;
  /** Free parameters, log-likelihood and the information criteria. */
  parameterCount: number;
  logLikelihood: number;
  aic: number;
  bic: number;
  pdf(x: number): number;
  /** Short name with fitted parameters, e.g. "N(μ=0.42, σ=0.11)". */
  label: string;
  /** The density written out, e.g. "f(x) = exp(−(x−μ)²/(2σ²)) / (σ√(2π))". */
  formula: string;
}

export interface DistributionFits {
  /** Fits sorted by BIC, best first. */
  candidates: FittedDistribution[];
  best: FittedDistribution | null;
  criterion: "BIC";
}

const MINIMUM_SAMPLE_SIZE = 3;
const HALF_LOG_TWO_PI = 0.5 * Math.log(2 * Math.PI);

/**
 * A parameter at 3 significant digits with trailing zeros trimmed, in
 * scientific notation below 1e-3 or from 1e5 on.
 */
export function formatParameter(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return String(value);
  }
  const rounded = Number(value.toPrecision(3));
  const magnitude = Math.abs(rounded);
  if (magnitude >= 1e-3 && magnitude < 1e5) {
    return String(rounded);
  }
  const [mantissa, exponent] = rounded.toExponential(2).split("e");
  const trimmedMantissa = mantissa.includes(".") ? mantissa.replace(/\.?0+$/, "") : mantissa;
  return `${trimmedMantissa}e${Number(exponent)}`;
}

const FORMULAS: Readonly<Record<DistributionFamily, string>> = {
  normal: "f(x) = exp(−(x−μ)²/(2σ²)) / (σ√(2π))",
  lognormal: "f(x) = exp(−(ln x−μ)²/(2σ²)) / (xσ√(2π))",
  exponential: "f(x) = λ·exp(−λx)",
  gamma: "f(x) = x^(k−1)·exp(−x/θ) / (Γ(k)·θ^k)",
  beta: "f(x) = x^(α−1)·(1−x)^(β−1) / B(α, β)",
  "student-t": "f(x) = Γ((ν+1)/2) / (σ√(νπ)·Γ(ν/2)) · (1 + ((x−μ)/σ)²/ν)^(−(ν+1)/2)",
};

interface FitSpecification {
  family: DistributionFamily;
  parameters: Readonly<Record<string, number>>;
  parameterCount: number;
  label: string;
  /** Natural log of the density; -Infinity outside the support. */
  logPdf(x: number): number;
}

function assembleFit(
  specification: FitSpecification,
  sample: ReadonlyArray<number>,
): FittedDistribution {
  const { family, parameters, parameterCount, label, logPdf } = specification;
  let logLikelihood = 0;
  for (const value of sample) {
    logLikelihood += logPdf(value);
  }
  return {
    family,
    parameters,
    parameterCount,
    logLikelihood,
    aic: 2 * parameterCount - 2 * logLikelihood,
    bic: parameterCount * Math.log(sample.length) - 2 * logLikelihood,
    pdf: (x: number) => Math.exp(logPdf(x)),
    label,
    formula: FORMULAS[family],
  };
}

function normalLogPdf(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return -0.5 * z * z - Math.log(sigma) - HALF_LOG_TWO_PI;
}

/** Mean and the 1/n standard deviation, the normal MLE. */
function normalMaximumLikelihood(sample: ReadonlyArray<number>): { mu: number; sigma: number } {
  const mu = mean(sample);
  let sumSquares = 0;
  for (const value of sample) {
    sumSquares += (value - mu) ** 2;
  }
  return { mu, sigma: Math.sqrt(sumSquares / sample.length) };
}

function fitNormal(sample: ReadonlyArray<number>): FittedDistribution {
  const { mu, sigma } = normalMaximumLikelihood(sample);
  return assembleFit(
    {
      family: "normal",
      parameters: { mu, sigma },
      parameterCount: 2,
      label: `N(μ=${formatParameter(mu)}, σ=${formatParameter(sigma)})`,
      logPdf: (x) => normalLogPdf(x, mu, sigma),
    },
    sample,
  );
}

function fitLognormal(sample: ReadonlyArray<number>): FittedDistribution {
  const { mu, sigma } = normalMaximumLikelihood(sample.map(Math.log));
  return assembleFit(
    {
      family: "lognormal",
      parameters: { mu, sigma },
      parameterCount: 2,
      label: `LogNormal(μ=${formatParameter(mu)}, σ=${formatParameter(sigma)})`,
      logPdf: (x) =>
        x > 0 ? normalLogPdf(Math.log(x), mu, sigma) - Math.log(x) : Number.NEGATIVE_INFINITY,
    },
    sample,
  );
}

function fitExponential(sample: ReadonlyArray<number>): FittedDistribution {
  const rate = 1 / mean(sample);
  return assembleFit(
    {
      family: "exponential",
      parameters: { rate },
      parameterCount: 1,
      label: `Exp(λ=${formatParameter(rate)})`,
      logPdf: (x) => (x >= 0 ? Math.log(rate) - rate * x : Number.NEGATIVE_INFINITY),
    },
    sample,
  );
}

const NEWTON_MAX_ITERATIONS = 100;
const NEWTON_RELATIVE_TOLERANCE = 1e-12;

/**
 * Root of ln(k) − digamma(k) = gap: the gamma MLE of the shape, where gap is
 * ln(mean) − mean(ln x). The function is convex and decreasing, so Newton
 * from Minka's approximation converges.
 */
function solveGammaShape(gap: number): number {
  let shape = (3 - gap + Math.sqrt((gap - 3) ** 2 + 24 * gap)) / (12 * gap);
  for (let iteration = 0; iteration < NEWTON_MAX_ITERATIONS; ++iteration) {
    const residual = Math.log(shape) - digamma(shape) - gap;
    const slope = 1 / shape - trigamma(shape);
    const next = shape - residual / slope;
    const updated = next > 0 ? next : shape / 2;
    const converged = Math.abs(updated - shape) <= NEWTON_RELATIVE_TOLERANCE * shape;
    shape = updated;
    if (converged) {
      break;
    }
  }
  return shape;
}

function fitGamma(sample: ReadonlyArray<number>): FittedDistribution {
  const sampleMean = mean(sample);
  const shape = solveGammaShape(Math.log(sampleMean) - mean(sample.map(Math.log)));
  const rate = shape / sampleMean;
  const logNormalizer = shape * Math.log(rate) - logGamma(shape);
  return assembleFit(
    {
      family: "gamma",
      parameters: { shape, rate },
      parameterCount: 2,
      label: `Gamma(k=${formatParameter(shape)}, θ=${formatParameter(1 / rate)})`,
      logPdf: (x) =>
        x > 0 ? (shape - 1) * Math.log(x) - rate * x + logNormalizer : Number.NEGATIVE_INFINITY,
    },
    sample,
  );
}

const BETA_BACKTRACKING_STEPS = 60;

/**
 * Beta MLE by Newton on the score equations, started at the method of
 * moments. A step is halved until the parameters stay positive and the
 * likelihood does not drop, so the result is never worse than the start.
 */
function solveBetaParameters(sample: ReadonlyArray<number>): { alpha: number; beta: number } {
  const meanLogX = mean(sample.map(Math.log));
  const meanLogOneMinusX = mean(sample.map((value) => Math.log1p(-value)));
  const averageLogLikelihood = (alpha: number, beta: number) =>
    logGamma(alpha + beta) -
    logGamma(alpha) -
    logGamma(beta) +
    (alpha - 1) * meanLogX +
    (beta - 1) * meanLogOneMinusX;

  const sampleMean = mean(sample);
  let squares = 0;
  for (const value of sample) {
    squares += (value - sampleMean) ** 2;
  }
  const concentration = (sampleMean * (1 - sampleMean)) / (squares / sample.length) - 1;
  let alpha = sampleMean * concentration;
  let beta = (1 - sampleMean) * concentration;

  for (let iteration = 0; iteration < NEWTON_MAX_ITERATIONS; ++iteration) {
    const total = alpha + beta;
    const totalTrigamma = trigamma(total);
    const gradientAlpha = meanLogX + digamma(total) - digamma(alpha);
    const gradientBeta = meanLogOneMinusX + digamma(total) - digamma(beta);
    const hessianAlpha = totalTrigamma - trigamma(alpha);
    const hessianBeta = totalTrigamma - trigamma(beta);
    const determinant = hessianAlpha * hessianBeta - totalTrigamma ** 2;
    const stepAlpha = -(hessianBeta * gradientAlpha - totalTrigamma * gradientBeta) / determinant;
    const stepBeta = -(hessianAlpha * gradientBeta - totalTrigamma * gradientAlpha) / determinant;

    const current = averageLogLikelihood(alpha, beta);
    let scale = 1;
    let accepted = false;
    for (let attempt = 0; attempt < BETA_BACKTRACKING_STEPS; ++attempt) {
      const nextAlpha = alpha + scale * stepAlpha;
      const nextBeta = beta + scale * stepBeta;
      if (nextAlpha > 0 && nextBeta > 0 && averageLogLikelihood(nextAlpha, nextBeta) >= current) {
        accepted = true;
        break;
      }
      scale /= 2;
    }
    if (!accepted) {
      break;
    }
    const relativeChange = Math.max(
      Math.abs(scale * stepAlpha) / alpha,
      Math.abs(scale * stepBeta) / beta,
    );
    alpha += scale * stepAlpha;
    beta += scale * stepBeta;
    if (relativeChange <= NEWTON_RELATIVE_TOLERANCE) {
      break;
    }
  }
  return { alpha, beta };
}

function fitBeta(sample: ReadonlyArray<number>): FittedDistribution {
  const { alpha, beta } = solveBetaParameters(sample);
  const logNormalizer = logGamma(alpha + beta) - logGamma(alpha) - logGamma(beta);
  return assembleFit(
    {
      family: "beta",
      parameters: { alpha, beta },
      parameterCount: 2,
      label: `Beta(α=${formatParameter(alpha)}, β=${formatParameter(beta)})`,
      logPdf: (x) =>
        x > 0 && x < 1
          ? (alpha - 1) * Math.log(x) + (beta - 1) * Math.log1p(-x) + logNormalizer
          : Number.NEGATIVE_INFINITY,
    },
    sample,
  );
}

function studentTLogPdf(x: number, mu: number, sigma: number, dof: number): number {
  const z = (x - mu) / sigma;
  return (
    logGamma((dof + 1) / 2) -
    logGamma(dof / 2) -
    0.5 * Math.log(dof * Math.PI) -
    Math.log(sigma) -
    ((dof + 1) / 2) * Math.log1p((z * z) / dof)
  );
}

interface StudentTProfile {
  dof: number;
  mu: number;
  sigma: number;
  logLikelihood: number;
}

const STUDENT_T_EM_MAX_ITERATIONS = 1000;
const STUDENT_T_EM_TOLERANCE = 1e-9;
const STUDENT_T_MIN_DOF = 0.5;
const STUDENT_T_MAX_DOF = 200;
const STUDENT_T_GRID_SIZE = 24;
/** Width of the final bracket in ln(dof): a relative precision of 1e-5 on the degrees of freedom. */
const STUDENT_T_LOG_DOF_TOLERANCE = 1e-5;
const INVERSE_GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2;

function quantileOfSorted(sorted: ReadonlyArray<number>, probability: number): number {
  const position = probability * (sorted.length - 1);
  const below = Math.floor(position);
  const above = Math.min(below + 1, sorted.length - 1);
  return sorted[below] + (position - below) * (sorted[above] - sorted[below]);
}

/** Median and a MAD-based scale (the sample spread when the MAD is zero), a start robust to heavy tails. */
function robustLocationAndScale(sample: ReadonlyArray<number>): {
  location: number;
  scale: number;
} {
  const sorted = [...sample].sort((a, b) => a - b);
  const location = quantileOfSorted(sorted, 0.5);
  const deviations = sorted.map((value) => Math.abs(value - location)).sort((a, b) => a - b);
  const medianDeviation = quantileOfSorted(deviations, 0.5);
  if (medianDeviation > 0) {
    return { location, scale: 1.4826 * medianDeviation };
  }
  return { location, scale: normalMaximumLikelihood(sample).sigma };
}

/**
 * Location, scale and log-likelihood of the Student-t MLE at fixed degrees of
 * freedom, by EM: each point is weighted by how typical it is under the
 * current fit, then location and scale are refit as weighted moments.
 */
function studentTProfile(
  sample: ReadonlyArray<number>,
  dof: number,
  start: { location: number; scale: number },
): StudentTProfile {
  const weights = new Float64Array(sample.length);
  let mu = start.location;
  let scaleSquared = start.scale ** 2;
  for (let iteration = 0; iteration < STUDENT_T_EM_MAX_ITERATIONS; ++iteration) {
    let weightSum = 0;
    let weightedValueSum = 0;
    for (let index = 0; index < sample.length; ++index) {
      const weight = (dof + 1) / (dof + (sample[index] - mu) ** 2 / scaleSquared);
      weights[index] = weight;
      weightSum += weight;
      weightedValueSum += weight * sample[index];
    }
    const nextMu = weightedValueSum / weightSum;
    let weightedSquares = 0;
    for (let index = 0; index < sample.length; ++index) {
      weightedSquares += weights[index] * (sample[index] - nextMu) ** 2;
    }
    const nextScaleSquared = weightedSquares / sample.length;
    const scale = Math.sqrt(scaleSquared);
    const converged =
      Math.abs(nextMu - mu) <= STUDENT_T_EM_TOLERANCE * scale &&
      Math.abs(Math.sqrt(nextScaleSquared) - scale) <= STUDENT_T_EM_TOLERANCE * scale;
    mu = nextMu;
    scaleSquared = nextScaleSquared;
    if (converged) {
      break;
    }
  }
  const sigma = Math.sqrt(scaleSquared);
  let logLikelihood = 0;
  for (const value of sample) {
    logLikelihood += studentTLogPdf(value, mu, sigma, dof);
  }
  return { dof, mu, sigma, logLikelihood };
}

/**
 * Student-t MLE: the profile log-likelihood over the degrees of freedom is
 * scanned on a log grid, then the best grid cell is refined by golden section.
 */
function solveStudentT(sample: ReadonlyArray<number>): StudentTProfile {
  const start = robustLocationAndScale(sample);
  const profileAtLogDof = (logDof: number) => studentTProfile(sample, Math.exp(logDof), start);
  const logMin = Math.log(STUDENT_T_MIN_DOF);
  const logMax = Math.log(STUDENT_T_MAX_DOF);
  const logStep = (logMax - logMin) / (STUDENT_T_GRID_SIZE - 1);

  let bestIndex = 0;
  let best = profileAtLogDof(logMin);
  for (let index = 1; index < STUDENT_T_GRID_SIZE; ++index) {
    const profile = profileAtLogDof(logMin + index * logStep);
    if (profile.logLikelihood > best.logLikelihood) {
      best = profile;
      bestIndex = index;
    }
  }

  let left = logMin + Math.max(bestIndex - 1, 0) * logStep;
  let right = logMin + Math.min(bestIndex + 1, STUDENT_T_GRID_SIZE - 1) * logStep;
  let leftProbe = right - INVERSE_GOLDEN_RATIO * (right - left);
  let rightProbe = left + INVERSE_GOLDEN_RATIO * (right - left);
  let leftProfile = profileAtLogDof(leftProbe);
  let rightProfile = profileAtLogDof(rightProbe);
  while (right - left > STUDENT_T_LOG_DOF_TOLERANCE) {
    if (leftProfile.logLikelihood > rightProfile.logLikelihood) {
      right = rightProbe;
      rightProbe = leftProbe;
      rightProfile = leftProfile;
      leftProbe = right - INVERSE_GOLDEN_RATIO * (right - left);
      leftProfile = profileAtLogDof(leftProbe);
    } else {
      left = leftProbe;
      leftProbe = rightProbe;
      leftProfile = rightProfile;
      rightProbe = left + INVERSE_GOLDEN_RATIO * (right - left);
      rightProfile = profileAtLogDof(rightProbe);
    }
  }
  for (const profile of [leftProfile, rightProfile]) {
    if (profile.logLikelihood > best.logLikelihood) {
      best = profile;
    }
  }
  return best;
}

function fitStudentT(sample: ReadonlyArray<number>): FittedDistribution {
  const { dof, mu, sigma } = solveStudentT(sample);
  return assembleFit(
    {
      family: "student-t",
      parameters: { mu, sigma, nu: dof },
      parameterCount: 3,
      label: `t(μ=${formatParameter(mu)}, σ=${formatParameter(sigma)}, ν=${formatParameter(dof)})`,
      logPdf: (x) => studentTLogPdf(x, mu, sigma, dof),
    },
    sample,
  );
}

/**
 * Fits every distribution whose support contains the sample (normal and
 * Student-t always; lognormal, exponential and gamma when every value is
 * positive; beta when every value lies strictly inside (0, 1)) and ranks
 * them by BIC. Non-finite values are ignored. A sample with fewer than three
 * values or no spread has no fit.
 */
export function fitDistributions(values: ArrayLike<number>): DistributionFits {
  const sample = finiteValues(values);
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const value of sample) {
    lowest = Math.min(lowest, value);
    highest = Math.max(highest, value);
  }
  if (sample.length < MINIMUM_SAMPLE_SIZE || !(highest > lowest)) {
    return { candidates: [], best: null, criterion: "BIC" };
  }
  const candidates = [fitNormal(sample), fitStudentT(sample)];
  if (lowest > 0) {
    candidates.push(fitLognormal(sample), fitExponential(sample), fitGamma(sample));
  }
  if (lowest > 0 && highest < 1) {
    candidates.push(fitBeta(sample));
  }
  // Array.prototype.sort is stable, so equal BICs keep the order above.
  candidates.sort((first, second) => first.bic - second.bic);
  return { candidates, best: candidates[0], criterion: "BIC" };
}

export interface KernelDensity {
  bandwidth: number;
  pdf(x: number): number;
}

/**
 * Gaussian kernel density estimate with Silverman's bandwidth
 * 0.9·min(σ, IQR/1.34)·n^(−1/5). Null with fewer than two finite values or
 * a zero bandwidth. Each `pdf` call costs O(n).
 */
export function kernelDensity(values: ArrayLike<number>): KernelDensity | null {
  const sample = finiteValues(values);
  if (sample.length < 2) {
    return null;
  }
  const sampleMean = mean(sample);
  let squares = 0;
  for (const value of sample) {
    squares += (value - sampleMean) ** 2;
  }
  const standardDeviation = Math.sqrt(squares / (sample.length - 1));
  const sorted = [...sample].sort((a, b) => a - b);
  const interquartileRange = quantileOfSorted(sorted, 0.75) - quantileOfSorted(sorted, 0.25);
  const bandwidth =
    0.9 * Math.min(standardDeviation, interquartileRange / 1.34) * sample.length ** -0.2;
  if (!(bandwidth > 0)) {
    return null;
  }
  const normalizer = 1 / (sample.length * bandwidth * Math.sqrt(2 * Math.PI));
  return {
    bandwidth,
    pdf: (x) => {
      let sum = 0;
      for (const value of sample) {
        const z = (x - value) / bandwidth;
        sum += Math.exp(-0.5 * z * z);
      }
      return normalizer * sum;
    },
  };
}
