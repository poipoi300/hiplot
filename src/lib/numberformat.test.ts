import { expect, test } from "bun:test";
import { formatTableNumber } from "./numberformat";

test("table numbers keep six significant digits and whole integers", () => {
  expect(formatTableNumber(0.000018082380535323)).toBe("1.80824e-5");
  expect(formatTableNumber(105293.00549446119)).toBe("105293");
  expect(formatTableNumber(0.0064088787160763135)).toBe("0.00640888");
  expect(formatTableNumber(1234567)).toBe("1234567");
  expect(formatTableNumber(-2.5)).toBe("-2.5");
  expect(formatTableNumber(Number.POSITIVE_INFINITY)).toBe("Infinity");
});
