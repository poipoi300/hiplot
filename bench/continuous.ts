/** Histogram-space feasibility probe; Node owns Playwright's Windows browser pipe. */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { createBenchmarkAbort, withDeadline } from "./deadline";

// Load the separately bundled harness: inlining it would also inline its CLI entry guard.
const harnessUrl = pathToFileURL(path.resolve("node_modules/.cache/parallel-bench.mjs")).href;
const { loadParallelBenchmark, SWIFTSHADER_FLAGS } = (await import(
  harnessUrl
)) as typeof import("./parallel");

const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Counts, numeric color sums and context share one linearly filtered RGBA32F texture. */
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_histogram;
uniform int u_bins;
uniform float u_height;
uniform float u_gap;
uniform float u_origin;
uniform float u_columns;
uniform bool u_curved;
out vec4 color;
void main() {
  float t = (gl_FragCoord.x - u_origin) / u_columns;
  float w = u_curved ? t * t * (3.0 - 2.0 * t) : t;
  float derivative = u_curved ? 6.0 * t * (1.0 - t) : 1.0;
  bool reverse = w < 0.5;
  float weight = reverse ? 1.0 - w : w;
  float y = gl_FragCoord.y / u_height * float(u_bins - 1);
  vec4 sums = vec4(0.0);
  for (int a = 0; a < u_bins; ++a) {
    float b = (y - (1.0 - weight) * float(a)) / weight;
    if (b < -1.0 || b > float(u_bins)) continue;
    vec2 endpoint = reverse ? vec2(b, float(a)) : vec2(float(a), b);
    vec4 cell = texture(u_histogram, (endpoint + 1.5) / float(u_bins + 2));
    float slope = derivative * (b - float(a)) * u_height / (float(u_bins - 1) * u_gap);
    float footprint = sqrt(1.0 + slope * slope);
    sums += cell * footprint / (weight * u_height / float(u_bins - 1));
  }
  float reference = max(2.0, 6000000.0 / u_height);
  float selected = clamp(log(1.0 + sums.r) / log(1.0 + reference), 0.0, 1.0);
  float context = 0.15 * clamp(log(1.0 + sums.g) / log(1.0 + reference), 0.0, 1.0);
  float key = sums.r > 0.0 ? sums.b / sums.r : 0.0;
  vec3 rgb = vec3(key, 0.35, 1.0 - key);
  color = vec4(rgb * selected + vec3(0.55) * context * (1.0 - selected),
               selected + context * (1.0 - selected));
}`;

interface ProbeResult {
  bins: number;
  pairs: number;
  curved: boolean;
  columnFraction: number;
  evaluatedColumns: number;
  samples: number[];
  p50: number;
  p95: number;
}

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      backend: { type: "string", default: "software" },
      out: { type: "string" },
      reps: { type: "string", default: "5" },
    },
  });
  if (values.backend !== "hardware" && values.backend !== "software") {
    throw new Error("Backend must be hardware or software");
  }
  const repetitions = Number(values.reps);
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("Invalid repetitions");
  const server = await chromium.launchServer({
    headless: true,
    channel: values.backend === "hardware" ? "chromium" : undefined,
    args: values.backend === "hardware" ? [] : SWIFTSHADER_FLAGS,
  });
  const browser = await chromium.connect(server.wsEndpoint());
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  const results: ProbeResult[] = [];
  let stage = "benchmark geometry";
  let geometry: { width: number; height: number; gaps: number[] } | undefined;
  let renderer = "unavailable";
  try {
    const abort = await createBenchmarkAbort(page, () => server.kill());
    await withDeadline(
      async () => {
        const loaded = await loadParallelBenchmark(
          page,
          { rows: 1_000_000, columns: 10, discrete: false, seed: 20261109 },
          "low",
        );
        renderer = loaded.renderer;
        geometry = await page.evaluate(() => {
          const win = window as unknown as {
            __parallelProbe: {
              instance: {
                parallelPlot: () => {
                  h: number;
                  w: number;
                  state: { dimensions: string[] };
                  position: (dimension: string) => number;
                };
              };
            };
          };
          const plot = win.__parallelProbe.instance.parallelPlot();
          const positions = plot.state.dimensions.map((dimension) => plot.position(dimension));
          return {
            width: plot.w,
            height: plot.h,
            gaps: positions.slice(1).map((x, i) => x - positions[i]),
          };
        });
        stage = "shader setup";
        const setup = await page.evaluate(
          ({ vertex, fragment, geometry }) => {
            const canvas = document.createElement("canvas");
            canvas.width = geometry.width;
            canvas.height = geometry.height;
            const gl = canvas.getContext("webgl2", { antialias: false });
            if (gl === null) throw new Error("WebGL2 unavailable");
            if (gl.getExtension("OES_texture_float_linear") === null)
              throw new Error("Float linear filtering unavailable");
            const compile = (type: number, source: string): WebGLShader => {
              const shader = gl.createShader(type);
              if (shader === null) throw new Error("No shader");
              gl.shaderSource(shader, source);
              gl.compileShader(shader);
              if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
                throw new Error(gl.getShaderInfoLog(shader) ?? "Compile failed");
              return shader;
            };
            const program = gl.createProgram();
            if (program === null) throw new Error("No program");
            gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
            gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS))
              throw new Error(gl.getProgramInfoLog(program) ?? "Link failed");
            gl.useProgram(program);
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            const uniforms = Object.fromEntries(
              ["bins", "height", "gap", "origin", "columns", "curved"].map((name) => [
                name,
                gl.getUniformLocation(program, `u_${name}`),
              ]),
            );
            (window as unknown as { __continuous: unknown }).__continuous = {
              gl,
              canvas,
              uniforms,
              texture,
            };
            return { width: canvas.width, height: canvas.height };
          },
          { vertex: VERTEX, fragment: FRAGMENT, geometry },
        );
        console.log(JSON.stringify({ renderer, geometry, setup }));
        for (const bins of [256, Math.ceil(geometry.height), 512]) {
          for (const pairs of [1, geometry.gaps.length]) {
            for (const columnFraction of [1, 0.25, 0.0625, 0.015625]) {
              for (const curved of [false, true]) {
                stage = `${bins} bins, ${pairs} pairs, ${columnFraction} columns, curved=${curved}`;
                const result = await page.evaluate(
                  ({ bins, pairs, columnFraction, curved, repetitions, gaps }) => {
                    const probe = (
                      window as unknown as {
                        __continuous: {
                          gl: WebGL2RenderingContext;
                          canvas: HTMLCanvasElement;
                          texture: WebGLTexture;
                          uniforms: Record<string, WebGLUniformLocation | null>;
                        };
                      }
                    ).__continuous;
                    const { gl, canvas, texture, uniforms } = probe;
                    const data = new Float32Array((bins + 2) ** 2 * 4);
                    for (let left = 0; left < bins; ++left) {
                      for (let right = 0; right < bins; ++right) {
                        const cell = ((right + 1) * (bins + 2) + left + 1) * 4;
                        data[cell] = 500000 / (bins * bins);
                        data[cell + 1] = data[cell];
                        data[cell + 2] = (data[cell] * left) / (bins - 1);
                      }
                    }
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    gl.texImage2D(
                      gl.TEXTURE_2D,
                      0,
                      gl.RGBA32F,
                      bins + 2,
                      bins + 2,
                      0,
                      gl.RGBA,
                      gl.FLOAT,
                      data,
                    );
                    gl.uniform1i(uniforms.bins, bins);
                    gl.uniform1i(uniforms.curved, curved ? 1 : 0);
                    gl.uniform1f(uniforms.height, canvas.height);
                    const visible = gaps.slice(0, pairs);
                    const totalGap = visible.reduce((sum, gap) => sum + gap, 0);
                    const widths = visible.map((gap) =>
                      Math.max(
                        2,
                        Math.ceil(gap * Math.min(1, canvas.width / totalGap) * columnFraction),
                      ),
                    );
                    const evaluatedColumns = widths.reduce((sum, width) => sum + width, 0);
                    const images = widths.map((width) => {
                      const image = gl.createTexture();
                      const target = gl.createFramebuffer();
                      gl.bindTexture(gl.TEXTURE_2D, image);
                      gl.texImage2D(
                        gl.TEXTURE_2D,
                        0,
                        gl.RGBA8,
                        width,
                        canvas.height,
                        0,
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        null,
                      );
                      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
                      gl.framebufferTexture2D(
                        gl.FRAMEBUFFER,
                        gl.COLOR_ATTACHMENT0,
                        gl.TEXTURE_2D,
                        image,
                        0,
                      );
                      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
                        throw new Error("Incomplete pair framebuffer");
                      return { image, target };
                    });
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    const destinationWidths = visible.map((gap) =>
                      Math.round(gap * Math.min(1, canvas.width / totalGap)),
                    );
                    const pixel = new Uint8Array(4);
                    const samples: number[] = [];
                    for (let repetition = -2; repetition < repetitions; ++repetition) {
                      const start = performance.now();
                      let origin = 0;
                      for (let pair = 0; pair < pairs; ++pair) {
                        gl.bindFramebuffer(gl.FRAMEBUFFER, images[pair].target);
                        gl.viewport(0, 0, widths[pair], canvas.height);
                        gl.uniform1f(uniforms.gap, visible[pair]);
                        gl.uniform1f(uniforms.origin, 0);
                        gl.uniform1f(uniforms.columns, widths[pair]);
                        gl.drawArrays(gl.TRIANGLES, 0, 3);
                        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
                        gl.blitFramebuffer(
                          0,
                          0,
                          widths[pair],
                          canvas.height,
                          origin,
                          0,
                          origin + destinationWidths[pair],
                          canvas.height,
                          gl.COLOR_BUFFER_BIT,
                          gl.LINEAR,
                        );
                        origin += destinationWidths[pair];
                      }
                      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
                      gl.readPixels(
                        Math.floor(origin / 2),
                        Math.floor(canvas.height / 2),
                        1,
                        1,
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        pixel,
                      );
                      const elapsed = performance.now() - start;
                      if (gl.getError() !== gl.NO_ERROR) throw new Error("GL error in timed probe");
                      if (pixel[3] === 0) throw new Error("Probe produced an empty center pixel");
                      if (repetition >= 0) samples.push(elapsed);
                    }
                    for (const { image, target } of images) {
                      gl.deleteFramebuffer(target);
                      gl.deleteTexture(image);
                    }
                    samples.sort((a, b) => a - b);
                    return {
                      bins,
                      pairs,
                      curved,
                      columnFraction,
                      evaluatedColumns,
                      samples,
                      p50: samples[Math.floor(samples.length * 0.5)],
                      p95: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))],
                    };
                  },
                  { bins, pairs, columnFraction, curved, repetitions, gaps: geometry.gaps },
                );
                results.push(result);
                console.log(JSON.stringify(result));
                if (values.out)
                  writeFileSync(
                    values.out,
                    JSON.stringify({ renderer, geometry, results }, null, 2),
                  );
              }
            }
          }
        }
      },
      600_000,
      () => `Continuous density probe at ${stage}`,
      abort,
    );
  } finally {
    if (values.out)
      writeFileSync(values.out, JSON.stringify({ renderer, geometry, results, stage }, null, 2));
    await browser.close();
    await server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
