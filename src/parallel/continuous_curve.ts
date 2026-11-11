/** Exact zero-tangent cubic with half-gap handles, expressed at normalized screen x. */
export function continuousCurve(t: number): readonly [weight: number, derivative: number] {
  let parameter = t;
  // dx/ds is at least 3/4; Newton is conditioned over the entire pair, including its ends.
  for (let iteration = 0; iteration < 5; ++iteration) {
    const product = parameter * (1 - parameter);
    const position = 1.5 * product + parameter ** 3;
    parameter -= (position - t) / (1.5 - 3 * product);
  }
  const product = parameter * (1 - parameter);
  return [parameter * parameter * (3 - 2 * parameter), (6 * product) / (1.5 - 3 * product)];
}

export const CONTINUOUS_CURVE_GLSL = `
vec2 continuousCurve(float t) {
  float parameter = t;
  for (int iteration = 0; iteration < 5; ++iteration) {
    float product = parameter * (1.0 - parameter);
    float position = 1.5 * product + parameter * parameter * parameter;
    parameter -= (position - t) / (1.5 - 3.0 * product);
  }
  float product = parameter * (1.0 - parameter);
  return vec2(parameter * parameter * (3.0 - 2.0 * parameter),
    6.0 * product / (1.5 - 3.0 * product));
}`;
