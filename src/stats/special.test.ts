import { describe, expect, test } from "bun:test";
import {
  digamma,
  logGamma,
  regularizedIncompleteBeta,
  studentTCdf,
  studentTQuantile,
  trigamma,
} from "./special";

const EULER_MASCHERONI = 0.5772156649015329;

describe("logGamma", () => {
  test("Gamma(1/2) is the square root of pi", () => {
    expect(logGamma(0.5)).toBeCloseTo(0.5 * Math.log(Math.PI), 12);
  });

  test("integers give log factorials", () => {
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(2)).toBeCloseTo(0, 12);
    expect(logGamma(6)).toBeCloseTo(Math.log(120), 12);
    expect(logGamma(21)).toBeCloseTo(Math.log(2432902008176640000), 11);
  });

  test("negative non-integers reflect through the sine", () => {
    // Gamma(-1/2) = -2 sqrt(pi)
    expect(logGamma(-0.5)).toBeCloseTo(Math.log(2 * Math.sqrt(Math.PI)), 12);
  });

  test("the poles are infinite", () => {
    expect(logGamma(0)).toBe(Number.POSITIVE_INFINITY);
    expect(logGamma(-3)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("digamma", () => {
  test("digamma(1) is minus the Euler-Mascheroni constant", () => {
    expect(digamma(1)).toBeCloseTo(-EULER_MASCHERONI, 12);
  });

  test("digamma(1/2) is -gamma - 2 ln 2", () => {
    expect(digamma(0.5)).toBeCloseTo(-EULER_MASCHERONI - 2 * Math.log(2), 12);
  });

  test("the recurrence digamma(x + 1) = digamma(x) + 1/x holds", () => {
    for (const x of [0.3, 1.7, 9.5, 42]) {
      expect(digamma(x + 1)).toBeCloseTo(digamma(x) + 1 / x, 11);
    }
  });

  test("negative arguments reflect", () => {
    expect(digamma(-0.5)).toBeCloseTo(0.03648997397857652, 12);
  });

  test("the poles are NaN", () => {
    expect(digamma(0)).toBeNaN();
    expect(digamma(-2)).toBeNaN();
  });
});

describe("trigamma", () => {
  test("trigamma(1) is pi squared over six", () => {
    expect(trigamma(1)).toBeCloseTo((Math.PI * Math.PI) / 6, 12);
  });

  test("trigamma(1/2) is pi squared over two", () => {
    expect(trigamma(0.5)).toBeCloseTo((Math.PI * Math.PI) / 2, 12);
  });

  test("it is the derivative of digamma", () => {
    const step = 1e-5;
    for (const x of [0.4, 2.5, 30]) {
      const numeric = (digamma(x + step) - digamma(x - step)) / (2 * step);
      expect(trigamma(x)).toBeCloseTo(numeric, 7);
    }
  });

  test("negative arguments reflect", () => {
    // trigamma(-1/2) = trigamma(3/2) + pi^2 / sin^2(-pi/2) - ... via the reflection identity
    expect(trigamma(-0.5)).toBeCloseTo(Math.PI * Math.PI - trigamma(1.5), 12);
    expect(trigamma(-0.5)).toBeCloseTo((Math.PI * Math.PI) / 2 + 4, 12);
  });

  test("the poles are NaN", () => {
    expect(trigamma(0)).toBeNaN();
  });
});

describe("regularizedIncompleteBeta", () => {
  test("the symmetric case is one half at the midpoint", () => {
    for (const a of [0.5, 1, 3, 20, 150]) {
      expect(regularizedIncompleteBeta(0.5, a, a)).toBeCloseTo(0.5, 12);
    }
  });

  test("Beta(1, 1) is the uniform CDF", () => {
    expect(regularizedIncompleteBeta(0.37, 1, 1)).toBeCloseTo(0.37, 12);
  });

  test("Beta(2, 3) matches its closed-form CDF", () => {
    const x = 0.3;
    expect(regularizedIncompleteBeta(x, 2, 3)).toBeCloseTo(
      6 * x ** 2 - 8 * x ** 3 + 3 * x ** 4,
      12,
    );
    const right = 0.8;
    expect(regularizedIncompleteBeta(right, 2, 3)).toBeCloseTo(
      6 * right ** 2 - 8 * right ** 3 + 3 * right ** 4,
      12,
    );
  });

  test("swapping arguments mirrors the CDF", () => {
    expect(
      regularizedIncompleteBeta(0.2, 2.5, 4) + regularizedIncompleteBeta(0.8, 4, 2.5),
    ).toBeCloseTo(1, 12);
  });

  test("the endpoints are exact", () => {
    expect(regularizedIncompleteBeta(0, 2, 3)).toBe(0);
    expect(regularizedIncompleteBeta(1, 2, 3)).toBe(1);
  });

  test("out-of-domain arguments are NaN", () => {
    expect(regularizedIncompleteBeta(-0.1, 2, 3)).toBeNaN();
    expect(regularizedIncompleteBeta(0.5, 0, 3)).toBeNaN();
  });
});

describe("studentTCdf", () => {
  test("one degree of freedom is the Cauchy CDF", () => {
    expect(studentTCdf(1, 1)).toBeCloseTo(0.75, 12);
    expect(studentTCdf(-1, 1)).toBeCloseTo(0.25, 12);
    expect(studentTCdf(3, 1)).toBeCloseTo(0.5 + Math.atan(3) / Math.PI, 12);
  });

  test("two degrees of freedom match the closed form", () => {
    const t = 1.7;
    expect(studentTCdf(t, 2)).toBeCloseTo(0.5 + t / (2 * Math.sqrt(2 + t * t)), 12);
  });

  test("the CDF is one half at zero and symmetric", () => {
    expect(studentTCdf(0, 7)).toBe(0.5);
    expect(studentTCdf(-0.8, 7) + studentTCdf(0.8, 7)).toBeCloseTo(1, 14);
  });

  test("infinite arguments saturate", () => {
    expect(studentTCdf(Number.POSITIVE_INFINITY, 5)).toBe(1);
    expect(studentTCdf(Number.NEGATIVE_INFINITY, 5)).toBe(0);
  });

  test("non-positive degrees of freedom are NaN", () => {
    expect(studentTCdf(1, 0)).toBeNaN();
  });
});

describe("studentTQuantile", () => {
  test("it reproduces the textbook 97.5% critical values", () => {
    expect(studentTQuantile(0.975, 1)).toBeCloseTo(12.7062047, 6);
    expect(studentTQuantile(0.975, 2)).toBeCloseTo(4.30265273, 7);
    expect(studentTQuantile(0.975, 4)).toBeCloseTo(2.77644511, 7);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.22813885, 7);
    expect(studentTQuantile(0.975, 30)).toBeCloseTo(2.04227246, 7);
  });

  test("large degrees of freedom approach the normal quantile", () => {
    expect(studentTQuantile(0.975, 1e6)).toBeCloseTo(1.95996, 3);
  });

  test("the lower tail mirrors the upper", () => {
    expect(studentTQuantile(0.025, 10)).toBeCloseTo(-2.22813885, 7);
    expect(studentTQuantile(0.5, 10)).toBe(0);
  });

  test("it inverts the CDF", () => {
    for (const [p, dof] of [
      [0.9, 3],
      [0.999, 12],
      [0.01, 50],
    ]) {
      expect(studentTCdf(studentTQuantile(p, dof), dof)).toBeCloseTo(p, 10);
    }
  });

  test("the extreme probabilities are infinite and invalid input is NaN", () => {
    expect(studentTQuantile(0, 5)).toBe(Number.NEGATIVE_INFINITY);
    expect(studentTQuantile(1, 5)).toBe(Number.POSITIVE_INFINITY);
    expect(studentTQuantile(1.2, 5)).toBeNaN();
    expect(studentTQuantile(0.9, -1)).toBeNaN();
  });
});
