/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Special functions behind the distribution fits and confidence intervals. */

const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];
const HALF_LOG_TWO_PI = 0.5 * Math.log(2 * Math.PI);

/** Natural log of |Gamma(x)| by the Lanczos approximation; Infinity at the poles 0, -1, -2, ... */
export function logGamma(x: number): number {
  if (x <= 0 && Number.isInteger(x)) {
    return Number.POSITIVE_INFINITY;
  }
  if (x < 0.5) {
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  }
  const shifted = x - 1;
  let series = LANCZOS_COEFFICIENTS[0];
  for (let term = 1; term < LANCZOS_COEFFICIENTS.length; ++term) {
    series += LANCZOS_COEFFICIENTS[term] / (shifted + term);
  }
  const tail = shifted + LANCZOS_G + 0.5;
  return HALF_LOG_TWO_PI + (shifted + 0.5) * Math.log(tail) - tail + Math.log(series);
}

/** Arguments at or above this make the asymptotic series for digamma and trigamma accurate to double precision. */
const ASYMPTOTIC_THRESHOLD = 10;

/** Digamma (derivative of logGamma); NaN at the poles. */
export function digamma(x: number): number {
  if (x <= 0 && Number.isInteger(x)) {
    return Number.NaN;
  }
  if (x < 0) {
    return digamma(1 - x) - Math.PI / Math.tan(Math.PI * x);
  }
  let argument = x;
  let result = 0;
  while (argument < ASYMPTOTIC_THRESHOLD) {
    result -= 1 / argument;
    argument += 1;
  }
  const inverseSquare = 1 / (argument * argument);
  const series =
    inverseSquare *
    (1 / 12 -
      inverseSquare *
        (1 / 120 -
          inverseSquare *
            (1 / 252 -
              inverseSquare *
                (1 / 240 -
                  inverseSquare *
                    (1 / 132 - inverseSquare * (691 / 32760 - inverseSquare / 12))))));
  return result + Math.log(argument) - 0.5 / argument - series;
}

/** Trigamma (derivative of digamma); NaN at the poles. */
export function trigamma(x: number): number {
  if (x <= 0 && Number.isInteger(x)) {
    return Number.NaN;
  }
  if (x < 0) {
    const sine = Math.sin(Math.PI * x);
    return (Math.PI * Math.PI) / (sine * sine) - trigamma(1 - x);
  }
  let argument = x;
  let result = 0;
  while (argument < ASYMPTOTIC_THRESHOLD) {
    result += 1 / (argument * argument);
    argument += 1;
  }
  const inverse = 1 / argument;
  const inverseSquare = inverse * inverse;
  const series =
    inverse *
    (1 +
      inverse *
        (0.5 +
          inverse *
            (1 / 6 -
              inverseSquare *
                (1 / 30 -
                  inverseSquare *
                    (1 / 42 -
                      inverseSquare *
                        (1 / 30 - inverseSquare * (5 / 66 - inverseSquare * (691 / 2730))))))));
  return result + series;
}

const BETA_CONTINUED_FRACTION_MAX_ITERATIONS = 10000;
const BETA_CONTINUED_FRACTION_TOLERANCE = 1e-15;
/** Floor that keeps the modified Lentz recurrences away from division by zero. */
const LENTZ_TINY = 1e-300;

/** One modified Lentz update: folds a continued-fraction coefficient into (c, d). */
function lentzStep(coefficient: number, c: number, d: number): { c: number; d: number } {
  const denominator = 1 + coefficient * d;
  const ratio = 1 + coefficient / c;
  return {
    c: Math.abs(ratio) < LENTZ_TINY ? LENTZ_TINY : ratio,
    d: 1 / (Math.abs(denominator) < LENTZ_TINY ? LENTZ_TINY : denominator),
  };
}

/** Continued fraction of the incomplete beta function, by the modified Lentz method. */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const sum = a + b;
  let c = 1;
  let d = lentzStep(-(sum * x) / (a + 1), 1, 1).d;
  let fraction = d;
  for (let iteration = 1; iteration <= BETA_CONTINUED_FRACTION_MAX_ITERATIONS; ++iteration) {
    const twice = 2 * iteration;
    const evenCoefficient = (iteration * (b - iteration) * x) / ((a - 1 + twice) * (a + twice));
    ({ c, d } = lentzStep(evenCoefficient, c, d));
    fraction *= d * c;
    const oddCoefficient =
      (-(a + iteration) * (sum + iteration) * x) / ((a + twice) * (a + 1 + twice));
    ({ c, d } = lentzStep(oddCoefficient, c, d));
    const delta = d * c;
    fraction *= delta;
    if (Math.abs(delta - 1) < BETA_CONTINUED_FRACTION_TOLERANCE) {
      return fraction;
    }
  }
  throw new Error(`incomplete beta continued fraction did not converge for a=${a}, b=${b}`);
}

/**
 * Regularized incomplete beta function I_x(a, b), the CDF of Beta(a, b) at
 * x. NaN unless a and b are positive and x lies in [0, 1].
 */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (!(a > 0 && b > 0 && x >= 0 && x <= 1)) {
    return Number.NaN;
  }
  if (x === 0 || x === 1) {
    return x;
  }
  const logFront =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  // The fraction converges quickly only left of the mean; mirror otherwise.
  if (x < (a + 1) / (a + b + 2)) {
    return (Math.exp(logFront) * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (Math.exp(logFront) * betaContinuedFraction(1 - x, b, a)) / b;
}

/** P(T > t) for t >= 0 under Student's t with `dof` degrees of freedom. */
function studentTUpperTail(t: number, dof: number): number {
  return 0.5 * regularizedIncompleteBeta(dof / (dof + t * t), dof / 2, 0.5);
}

/** CDF of Student's t with `dof` degrees of freedom; NaN unless dof is positive. */
export function studentTCdf(t: number, dof: number): number {
  if (Number.isNaN(t) || !(dof > 0)) {
    return Number.NaN;
  }
  const upperTail = studentTUpperTail(Math.abs(t), dof);
  return t > 0 ? 1 - upperTail : upperTail;
}

const QUANTILE_BISECTION_STEPS = 100;

/**
 * Inverse of the Student's t CDF, accurate to double precision. NaN unless p
 * lies in [0, 1] and dof is positive.
 */
export function studentTQuantile(p: number, dof: number): number {
  if (!(p >= 0 && p <= 1 && dof > 0)) {
    return Number.NaN;
  }
  if (p === 0 || p === 1) {
    return p === 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (p === 0.5) {
    return 0;
  }
  const tailProbability = Math.min(p, 1 - p);
  let upper = 1;
  while (studentTUpperTail(upper, dof) > tailProbability) {
    upper *= 2;
  }
  let lower = upper === 1 ? 0 : upper / 2;
  for (let step = 0; step < QUANTILE_BISECTION_STEPS; ++step) {
    const middle = 0.5 * (lower + upper);
    if (studentTUpperTail(middle, dof) > tailProbability) {
      lower = middle;
    } else {
      upper = middle;
    }
  }
  const magnitude = 0.5 * (lower + upper);
  return p > 0.5 ? magnitude : -magnitude;
}
