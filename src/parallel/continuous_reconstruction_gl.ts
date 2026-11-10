import type { ContinuousPairImage } from "./continuous_density";
import { type ContinuousReconstructionPlan, continuousSupport } from "./continuous_reconstruction";
import type { ContinuousHistogram, ContinuousRequest } from "./continuous_types";

const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_selected;
uniform sampler2D u_context;
uniform sampler2D u_guides;
uniform int u_sourceWidth;
uniform int u_width;
uniform int u_rows;
uniform float u_height;
layout(location = 0) out vec4 color;

bool validGuide(vec2 guide) {
  // Absent support is encoded as [1, -1], outside the ordered finite envelopes.
  return guide.x <= guide.y;
}
vec4 bytes(vec4 value) {
  // Uint8ClampedArray uses ties-to-even, including before layer compositing.
  return roundEven(clamp(value, 0.0, 255.0));
}
vec4 sourcePixel(sampler2D image, int column, int row) {
  if (row < 0 || row >= u_rows) return vec4(0.0);
  return bytes(texelFetch(image, ivec2(column, row), 0) * 255.0);
}
float mappedCenter(float center, vec2 source, vec2 destination) {
  if (!validGuide(source) || !validGuide(destination)) return center;
  if (source.y - source.x <= 1.0)
    return center + (source.x + source.y - destination.x - destination.y) * 0.5;
  float scale;
  float offset;
  if (center < destination.x) {
    scale = destination.x > 0.0 ? source.x / destination.x : 0.0;
    offset = 0.0;
  } else if (center <= destination.y) {
    float span = destination.y - destination.x;
    scale = span > 0.0 ? (source.y - source.x) / span : 0.0;
    offset = span > 0.0 ? source.x - destination.x * scale : (source.x + source.y) * 0.5;
  } else {
    float span = u_height - destination.y;
    scale = span > 0.0 ? (u_height - source.y) / span : 1.0;
    offset = source.y - destination.y * scale;
  }
  return center * scale + offset;
}
vec4 verticalSample(sampler2D image, int column, float center, vec2 source, vec2 destination) {
  if (!validGuide(source) || !validGuide(destination)) return vec4(0.0);
  float sourceY = mappedCenter(center, source, destination) - 0.5;
  int top = int(floor(sourceY));
  float fraction = sourceY - float(top);
  vec4 first = sourcePixel(image, column, top);
  vec4 second = sourcePixel(image, column, top + 1);
  float firstAlpha = first.a * (1.0 - fraction);
  float secondAlpha = second.a * fraction;
  return vec4(first.rgb * firstAlpha + second.rgb * secondAlpha, firstAlpha + secondAlpha);
}
vec4 reconstructLayer(sampler2D image, int layer, ivec2 pixel) {
  // The CPU bypass preserves even transparent RGB when no reconstruction is needed.
  if (u_sourceWidth == u_width) return sourcePixel(image, pixel.x, pixel.y);
  float sourceX = clamp((float(pixel.x) + 0.5) * float(u_sourceWidth) / float(u_width) - 0.5,
    0.0, float(u_sourceWidth - 1));
  int below = int(floor(sourceX));
  int above = min(below + 1, u_sourceWidth - 1);
  float fraction = sourceX - float(below);
  int neighbors[4] = int[4](max(0, below - 1), below, above, min(u_sourceWidth - 1, above + 1));
  vec2 destination = texelFetch(u_guides, ivec2(pixel.x, layer * 2 + 1), 0).rg;
  vec2 guides[4];
  bool cubic = u_sourceWidth >= 4 && validGuide(destination);
  for (int neighbor = 0; neighbor < 4; ++neighbor) {
    guides[neighbor] = texelFetch(u_guides, ivec2(neighbors[neighbor], layer * 2), 0).rg;
    cubic = cubic && validGuide(guides[neighbor]);
  }
  float squared = fraction * fraction;
  float cubed = squared * fraction;
  float weights[4];
  weights[0] = cubic ? -0.5 * fraction + squared - 0.5 * cubed : 0.0;
  weights[1] = cubic ? 1.0 - 2.5 * squared + 1.5 * cubed : 1.0 - fraction;
  weights[2] = cubic ? 0.5 * fraction + 2.0 * squared - 1.5 * cubed : fraction;
  weights[3] = cubic ? -0.5 * squared + 0.5 * cubed : 0.0;
  float alpha = 0.0;
  float minimumAlpha = 255.0;
  float maximumAlpha = 0.0;
  vec4 linear = vec4(0.0);
  for (int neighbor = 0; neighbor < 4; ++neighbor) {
    if ((neighbor == 0 || neighbor == 3) && weights[neighbor] == 0.0) continue;
    vec4 sampleValue = verticalSample(image, neighbors[neighbor], float(pixel.y) + 0.5,
      guides[neighbor], destination);
    alpha += sampleValue.a * weights[neighbor];
    if (neighbor == 1 || neighbor == 2) {
      float colorWeight = neighbor == 1 ? 1.0 - fraction : fraction;
      linear += sampleValue * colorWeight;
      minimumAlpha = min(minimumAlpha, sampleValue.a);
      maximumAlpha = max(maximumAlpha, sampleValue.a);
    }
  }
  alpha = clamp(alpha, minimumAlpha, maximumAlpha);
  if (alpha <= 0.0 || linear.a <= 0.0) return vec4(0.0);
  return bytes(vec4(linear.rgb / linear.a, alpha));
}
void main() {
  // Low FBO rows are top image rows, matching the density pass and CPU arrays.
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec4 selected = reconstructLayer(u_selected, 0, pixel);
  vec4 context = reconstructLayer(u_context, 1, pixel);
  float selectedAlpha = selected.a / 255.0;
  float contextShare = (context.a / 255.0) * (1.0 - selectedAlpha);
  float alpha = selectedAlpha + contextShare;
  if (alpha <= 0.0) {
    color = selected / 255.0;
    return;
  }
  color = bytes(vec4((selected.rgb * selectedAlpha + context.rgb * contextShare) / alpha,
    alpha * 255.0)) / 255.0;
}`;

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  if (program === null) throw new Error("Cannot allocate continuous reconstruction program");
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, FRAGMENT],
    ] as const) {
      const shader = gl.createShader(type);
      if (shader === null) throw new Error("Cannot allocate continuous reconstruction shader");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(`Continuous reconstruction shader: ${gl.getShaderInfoLog(shader)}`);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`Continuous reconstruction link: ${gl.getProgramInfoLog(program)}`);
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

/** Reconstruct independent MRT layers and composite with one draw and one final readback. */
export class ContinuousWebGLReconstruction {
  private readonly program: WebGLProgram;
  private readonly guides: WebGLTexture;
  private readonly output: WebGLTexture;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly uniforms = new Map<string, WebGLUniformLocation>();

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = createProgram(gl);
    const textures: WebGLTexture[] = [];
    let framebuffer: WebGLFramebuffer | null = null;
    const texture = (): WebGLTexture => {
      const result = gl.createTexture();
      if (result === null) throw new Error("Cannot allocate continuous reconstruction texture");
      textures.push(result);
      return result;
    };
    try {
      this.guides = texture();
      this.output = texture();
      framebuffer = gl.createFramebuffer();
      if (framebuffer === null)
        throw new Error("Cannot allocate continuous reconstruction framebuffer");
      this.framebuffer = framebuffer;
    } catch (error) {
      for (const ownedTexture of textures) gl.deleteTexture(ownedTexture);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteProgram(this.program);
      throw error;
    }
  }

  private uniform(name: string): WebGLUniformLocation {
    let location = this.uniforms.get(name);
    if (location === undefined) {
      const found = this.gl.getUniformLocation(this.program, `u_${name}`);
      if (found === null) throw new Error(`Missing continuous reconstruction uniform ${name}`);
      location = found;
      this.uniforms.set(name, location);
    }
    return location;
  }

  render(
    selected: WebGLTexture,
    context: WebGLTexture,
    histogram: ContinuousHistogram,
    frame: Pick<ContinuousRequest, "height" | "curved">,
    gap: number,
    sourceWidth: number,
    plan?: ContinuousReconstructionPlan,
  ): ContinuousPairImage {
    const { gl } = this;
    if (gl.isContextLost()) throw new Error("Continuous reconstruction WebGL context lost");
    const width = Math.ceil(gap);
    const height = Math.max(1, Math.ceil(frame.height));
    const guideWidth = Math.max(sourceWidth, width);
    if (!Number.isInteger(sourceWidth) || sourceWidth < 1 || !Number.isFinite(gap) || gap <= 0)
      throw new Error("Invalid continuous reconstruction width");
    if (!Number.isFinite(frame.height) || frame.height < 0)
      throw new Error("Invalid continuous reconstruction height");
    const maximumTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (Math.max(guideWidth, height, 4) > maximumTexture)
      throw new Error("Continuous reconstruction image exceeds WebGL texture capacity");
    // Source and destination get separate rows; neither reduces the maximum supported gap.
    const guides = new Float32Array(guideWidth * 4 * 2);
    for (const [layer, counts] of [histogram.selected, histogram.context].entries()) {
      const support =
        plan === undefined
          ? continuousSupport(histogram, counts, frame, gap, sourceWidth)
          : layer === 0
            ? plan.selected
            : plan.context;
      for (let column = 0; column < support.lower.length; ++column) {
        const source = column < sourceWidth;
        const row = layer * 2 + Number(!source);
        const index = source ? column : column - sourceWidth;
        const offset = (row * guideWidth + index) * 2;
        const valid =
          Number.isFinite(support.lower[column]) && Number.isFinite(support.upper[column]);
        guides[offset] = valid ? support.lower[column] : 1;
        guides[offset + 1] = valid ? support.upper[column] : -1;
      }
    }
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a React hook.
    gl.useProgram(this.program);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    for (const [unit, texture] of [selected, context, this.guides].entries()) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, guideWidth, 4, 0, gl.RG, gl.FLOAT, guides);
    this.configureTexture();
    gl.uniform1i(this.uniform("selected"), 0);
    gl.uniform1i(this.uniform("context"), 1);
    gl.uniform1i(this.uniform("guides"), 2);
    gl.uniform1i(this.uniform("sourceWidth"), sourceWidth);
    gl.uniform1i(this.uniform("width"), width);
    gl.uniform1i(this.uniform("rows"), height);
    gl.uniform1f(this.uniform("height"), frame.height);
    // Never bind an output on a sampler unit, even while allocating its storage.
    gl.activeTexture(gl.TEXTURE0 + 3);
    gl.bindTexture(gl.TEXTURE_2D, this.output);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.configureTexture();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.output, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Incomplete continuous reconstruction framebuffer");
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixels = new Uint8ClampedArray(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pixels.buffer));
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Continuous reconstruction WebGL error ${error}`);
    return { pixels, width, height };
  }

  private configureTexture(): void {
    const { gl } = this;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteTexture(this.guides);
    gl.deleteTexture(this.output);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteProgram(this.program);
  }
}
