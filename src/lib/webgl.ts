/** Links a program, releasing intermediate shaders and any failed program. */
export function linkProgram(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
  label: string,
): WebGLProgram {
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  if (program === null) throw new Error(`Cannot allocate ${label.toLowerCase()} program`);
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (shader === null) throw new Error(`Cannot allocate ${label.toLowerCase()} shader`);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(`${label} shader: ${gl.getShaderInfoLog(shader)}`);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`${label} link: ${gl.getProgramInfoLog(program)}`);
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}
