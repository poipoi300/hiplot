/**
 * Retained density blocks for brushing one axis of the exact line renderer.
 *
 * During a brush gesture only the brushed axis's selection changes. Rows that
 * fail another axis's brushes stay deselected; the others are selected exactly
 * when their value on the brushed axis lies inside its brushes, so sorted by
 * that axis they switch between selected and deselected in long runs. The
 * renderer sums every block of consecutive sorted rows once, as if selected,
 * into its own float layer. A frame then redraws only the blocks whose rows
 * are partly selected and adds every other block's layer to the selected or
 * the deselected densities. Each layer keeps sums and per-pixel maxima of its
 * own rows, so a frame never subtracts a row's contribution: maxima have no
 * inverse, and a float sum cannot give back what it rounded away (see
 * "Incremental density subtraction: rejected" in docs/PERFORMANCE.md).
 */

import { linkProgram } from "../lib/webgl";

/**
 * Rows grouped in blocks: the focus rows in near-equal blocks of consecutive
 * pixels on the focus axis (missing values last), then one block of every
 * other row. Within a block, rows keep the plot's draw order.
 */
export interface BlockPartition {
  /** The rows of each block in turn. */
  order: Uint32Array;
  /** Start of each block in `order`, then the end of the last block. */
  starts: Uint32Array;
  /** The block of each row. */
  blockOf: Uint32Array;
}

/** The pixel's bits as an unsigned key that sorts like the float; NaN (a missing value) last. */
function sortKey(view: Uint32Array, value: number, index: number): number {
  if (Number.isNaN(value)) return 0xffffffff;
  const bits = view[index];
  return (bits & 0x80000000) !== 0 ? ~bits >>> 0 : (bits | 0x80000000) >>> 0;
}

/**
 * Puts the rows flagged in `focus` in `blockCount` blocks by their rank in
 * `pixels` (ties by row), and the others in a last block. A block's rows
 * follow `drawOrder`, a permutation of the rows, rather than their pixels:
 * consecutive lines of a block would otherwise start at the same pixels of
 * the focus axis, and blending one pixel back to back serializes the GPU.
 * Two 16-bit counting passes keep the ranking linear.
 */
export function partitionRows(
  pixels: Float32Array,
  focus: Uint8Array,
  drawOrder: Uint32Array,
  blockCount: number,
): BlockPartition {
  const rows = pixels.length;
  if (focus.length !== rows || drawOrder.length !== rows) {
    throw new Error(
      `A focus of ${focus.length} rows and a draw order of ${drawOrder.length} for ${rows} pixels`,
    );
  }
  if (!Number.isSafeInteger(blockCount) || blockCount < 1) {
    throw new Error(`Cannot partition rows into ${blockCount} blocks`);
  }
  const bits = new Uint32Array(pixels.buffer, pixels.byteOffset, rows);
  let focused = 0;
  for (let row = 0; row < rows; ++row) focused += focus[row] === 0 ? 0 : 1;
  const keys = new Uint32Array(focused);
  const ranked = new Uint32Array(focused);
  for (let row = 0, at = 0; row < rows; ++row) {
    if (focus[row] === 0) continue;
    keys[at] = sortKey(bits, pixels[row], row);
    ranked[at++] = row;
  }
  const scratchRows = new Uint32Array(focused);
  const scratchKeys = new Uint32Array(focused);
  const counts = new Uint32Array(65537);
  for (const shift of [0, 16]) {
    counts.fill(0);
    for (let i = 0; i < focused; ++i) ++counts[((keys[i] >>> shift) & 0xffff) + 1];
    for (let digit = 1; digit < counts.length; ++digit) counts[digit] += counts[digit - 1];
    const [fromRows, fromKeys, toRows, toKeys] =
      shift === 0
        ? [ranked, keys, scratchRows, scratchKeys]
        : [scratchRows, scratchKeys, ranked, keys];
    for (let i = 0; i < focused; ++i) {
      const at = counts[(fromKeys[i] >>> shift) & 0xffff]++;
      toRows[at] = fromRows[i];
      toKeys[at] = fromKeys[i];
    }
  }
  const blocks = Math.max(1, Math.min(blockCount, focused));
  const starts = new Uint32Array(blocks + 2);
  for (let block = 0; block <= blocks; ++block) {
    starts[block] = Math.round((block * focused) / blocks);
  }
  starts[blocks + 1] = rows;
  const blockOf = new Uint32Array(rows).fill(blocks);
  for (let block = 0; block < blocks; ++block) {
    for (let rank = starts[block]; rank < starts[block + 1]; ++rank) blockOf[ranked[rank]] = block;
  }
  const order = new Uint32Array(rows);
  const next = starts.slice(0, blocks + 1);
  for (let at = 0; at < rows; ++at) {
    const row = drawOrder[at];
    order[next[blockOf[row]]++] = row;
  }
  return { order, starts, blockOf };
}

/**
 * How a frame takes a layer (see BlockLayers.accumulate): not at all, as for
 * a partly selected block, whose rows it draws one by one, or an unused
 * partial slot; or its rows as selected, or as deselected.
 */
export const LAYER_SKIPPED = 0;
export const LAYER_SELECTED = 1;
export const LAYER_CONTEXT = 2;

/**
 * Selected rows per block, kept from the rows whose flags change between
 * frames: a brush move changes few, and comparing flags a word at a time
 * reads a million rows far faster than gathering them block by block.
 */
export class BlockSelection {
  /** Selection flags of the last update, in row order, padded to whole words. */
  private readonly flags: Uint8Array;
  private readonly selected: Uint32Array;

  constructor(private readonly partition: BlockPartition) {
    this.flags = new Uint8Array(Math.ceil(partition.order.length / 4) * 4);
    this.selected = new Uint32Array(partition.starts.length - 1);
  }

  /**
   * Takes `selection` (per-row flags, 1 = selected) and sets each block's
   * state in `states`; returns how many rows the partly selected blocks hold,
   * which the frame redraws.
   */
  update(selection: Uint8Array, states: Uint8Array): number {
    const { starts, blockOf } = this.partition;
    const rows = blockOf.length;
    if (selection.length !== rows) {
      throw new Error(`A selection of ${selection.length} rows for ${rows} rows`);
    }
    if (states.length !== this.selected.length) {
      throw new Error(`${states.length} block states for ${this.selected.length} blocks`);
    }
    const { flags, selected } = this;
    // Whole words compare four rows at once where the selection's buffer allows it.
    const aligned = selection.byteOffset % 4 === 0;
    const words = aligned ? Math.floor(rows / 4) : 0;
    const now = aligned
      ? new Uint32Array(selection.buffer, selection.byteOffset, words)
      : new Uint32Array(0);
    const before = new Uint32Array(flags.buffer, 0, words);
    let row = 0;
    for (let word = 0; row < rows; ++word) {
      const end = word < words ? row + 4 : row + 1;
      if (word < words && now[word] === before[word]) {
        row = end;
        continue;
      }
      for (; row < end; ++row) {
        const flag = selection[row];
        if (flag === flags[row]) continue;
        if (flag > 1) throw new Error(`Selection flag ${flag} of row ${row} is not 0 or 1`);
        flags[row] = flag;
        selected[blockOf[row]] += flag === 1 ? 1 : -1;
      }
    }
    let partialRows = 0;
    for (let block = 0; block < states.length; ++block) {
      const size = starts[block + 1] - starts[block];
      if (selected[block] === 0) states[block] = LAYER_CONTEXT;
      else if (selected[block] === size) states[block] = LAYER_SELECTED;
      else {
        states[block] = LAYER_SKIPPED;
        partialRows += size;
      }
    }
    return partialRows;
  }
}

/**
 * Partly selected blocks a frame keeps drawn, so that the next frame redraws
 * only those whose rows changed: a brush edge that stays put, or the edge of
 * a block the brush has left, costs nothing more. Each slot holds a block's
 * selected and deselected rows apart, in two layers laid out as blocks are.
 */
export const PARTIAL_SLOTS = 4;

/** A partly selected block kept in a slot, with the selection it was drawn for. */
interface SlotEntry {
  block: number;
  /** Selection flags of the block's rows, in partition order. */
  pattern: Uint8Array;
}

/** The selected rows of a slot's block, in its first layer, or its deselected ones, in its second. */
export const SELECTED_HALF = 0;
export const DESELECTED_HALF = 1;

/** Rows a frame draws into one half of a slot. */
export interface HalfDraw {
  slot: number;
  half: typeof SELECTED_HALF | typeof DESELECTED_HALF;
  block: number;
  /** Positions of the rows in their block, in partition order. */
  positions: number[];
  /**
   * Whether the half is cleared first. Rows that joined a half since its last
   * frame are added onto what it holds: sums add and peaks keep the maximum.
   * A half that lost rows is drawn again, since neither can be taken back.
   */
  clear: boolean;
}

/** What a frame does with its partly selected blocks (see PartialSlots.plan). */
export interface SlotPlan {
  /** Rows to draw into the halves of slots, which then hold their blocks. */
  draw: HalfDraw[];
  /** Bit `i` set when slot `i` holds a block of this frame. */
  used: number;
  /** Partly selected blocks beyond the slots, drawn directly into the frame. */
  overflow: number[];
}

/** Positions in `pattern` whose flag is `flag`, and, given `previous`, was not. */
function positionsOf(pattern: Uint8Array, flag: number, previous: Uint8Array | null): number[] {
  const positions: number[] = [];
  for (let at = 0; at < pattern.length; ++at) {
    if (pattern[at] === flag && (previous === null || previous[at] !== flag)) positions.push(at);
  }
  return positions;
}

/**
 * Assigns partly selected blocks to slots, drawing only what changed in a
 * slot already holding the block. Slots take blocks of at most `maxRows`
 * rows: the focus blocks, not a large block of rows outside the focus.
 */
export class PartialSlots {
  private readonly entries: (SlotEntry | null)[] = Array.from(
    { length: PARTIAL_SLOTS },
    () => null,
  );

  constructor(readonly maxRows: number) {}

  /**
   * Plans a frame for the blocks `states` skips (see BlockSelection). Slots
   * the plan draws are recorded as holding their blocks: the caller must
   * draw them.
   */
  plan(partition: BlockPartition, selection: Uint8Array, states: Uint8Array): SlotPlan {
    const plan: SlotPlan = { draw: [], used: 0, overflow: [] };
    const waiting: [number, Uint8Array][] = [];
    for (let block = 0; block < states.length; ++block) {
      if (states[block] !== LAYER_SKIPPED) continue;
      const start = partition.starts[block];
      const pattern = new Uint8Array(partition.starts[block + 1] - start);
      for (let at = 0; at < pattern.length; ++at) {
        pattern[at] = selection[partition.order[start + at]];
      }
      const slot = this.entries.findIndex((entry) => entry?.block === block);
      if (slot !== -1) plan.used |= 1 << slot;
      waiting.push([block, pattern]);
    }
    for (const [block, pattern] of waiting) {
      if (pattern.length > this.maxRows) {
        plan.overflow.push(block);
        continue;
      }
      // The slot already holding this block, else any slot this frame leaves unused.
      let slot = this.entries.findIndex((entry) => entry?.block === block);
      const held = slot === -1 ? null : this.entries[slot];
      if (slot === -1) {
        slot = this.entries.findIndex((_, index) => (plan.used & (1 << index)) === 0);
      }
      if (slot === -1) {
        plan.overflow.push(block);
        continue;
      }
      plan.used |= 1 << slot;
      this.entries[slot] = { block, pattern };
      const previous = held?.pattern ?? null;
      const joined = [
        previous === null ? [] : positionsOf(pattern, 1, previous),
        previous === null ? [] : positionsOf(pattern, 0, previous),
      ];
      for (const half of [SELECTED_HALF, DESELECTED_HALF] as const) {
        const flag = half === SELECTED_HALF ? 1 : 0;
        const lost = previous === null || joined[1 - half].length > 0;
        if (lost) {
          plan.draw.push({
            slot,
            half,
            block,
            positions: positionsOf(pattern, flag, null),
            clear: true,
          });
        } else if (joined[half].length > 0) {
          plan.draw.push({ slot, half, block, positions: joined[half], clear: false });
        }
      }
    }
    return plan;
  }
}

/** GPU memory the layers of one brushed axis may take, partial slots included. */
export const BLOCK_MEMORY_BYTES = 1024 * 1024 * 1024;
/** More blocks than one per this many rows gain little: per-draw overhead dominates. */
export const MIN_BLOCK_ROWS = 256;
/**
 * Sets the block count from the rows, sqrt(rows / this): a brush frame sums
 * every layer and redraws the rows of the blocks a brush's edges cut, so B
 * blocks of R rows cost about B layers plus a few times R / B rows, and fewer
 * layers build faster. Measured on a desktop GPU: at 50,000 rows, 32 blocks
 * build a new axis's blocks in about 60% of the time 60 blocks took, with
 * brush frames as fast; at 1M rows, halving the blocks (this at 200) cost
 * 1 ms per brush frame, so there the count stays at what the memory holds.
 */
export const BLOCK_ROWS_PER_LAYER = 50;
/**
 * Fewer focus blocks than this leave so many rows partly selected that a
 * frame costs about as much as drawing every row: brushing then drafts.
 */
export const MIN_FOCUS_BLOCKS = 16;
/** Layers beside the focus blocks: the rows outside the focus, and two per partial slot. */
const EXTRA_LAYERS = 1 + 2 * PARTIAL_SLOTS;

/**
 * Bytes per pixel of one layer (see BlockLayers). The line on top takes a
 * whole RGBA32F texel: WebGL2 blends every attachment with one equation, and
 * only the alpha channel keeps the maximum.
 */
export function blockLayerBytes(valueColors: boolean, withOnTop: boolean): number {
  return 16 + (valueColors ? 0 : 4) + (withOnTop ? 16 : 0);
}

/** Whether MIN_FOCUS_BLOCKS and the other layers fit in BLOCK_MEMORY_BYTES at this target size. */
export function blocksFit(pixels: number, layerBytes: number): boolean {
  return (MIN_FOCUS_BLOCKS + EXTRA_LAYERS) * pixels * layerBytes <= BLOCK_MEMORY_BYTES;
}

/**
 * Blocks of focus rows: about sqrt(rows / BLOCK_ROWS_PER_LAYER), at least
 * MIN_FOCUS_BLOCKS but no more than one per MIN_BLOCK_ROWS rows, within
 * BLOCK_MEMORY_BYTES and the device's layers at this target size beside the
 * other layers; at least one. Call it only when `blocksFit`.
 */
export function blockCountFor(
  focusRows: number,
  pixels: number,
  layerBytes: number,
  maxLayers: number,
): number {
  if (!blocksFit(pixels, layerBytes)) {
    throw new Error(`Brush blocks of ${pixels} pixels do not fit in GPU memory`);
  }
  const affordable = Math.floor(BLOCK_MEMORY_BYTES / (pixels * layerBytes)) - EXTRA_LAYERS;
  const balanced = Math.max(
    MIN_FOCUS_BLOCKS,
    Math.ceil(Math.sqrt(focusRows / BLOCK_ROWS_PER_LAYER)),
  );
  const useful = Math.min(Math.ceil(focusRows / MIN_BLOCK_ROWS), balanced);
  return Math.max(1, Math.min(affordable, maxLayers - EXTRA_LAYERS, useful));
}

/** Throws if WebGL recorded an error, such as running out of memory, while `what` ran. */
function checkGl(gl: WebGL2RenderingContext, what: string): void {
  const error = gl.getError();
  if (error !== gl.NO_ERROR) throw new Error(`WebGL error 0x${error.toString(16)} ${what}`);
}

const ACCUMULATE_VERTEX_SHADER = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Sums whole layers into the density targets' layout (see
 * DENSITY_FRAGMENT_SHADER in webgl.ts), blended over any partly selected
 * blocks drawn there directly: colors add up and alphas keep the maximum. A
 * layer holds its rows as if all were selected: coverage-weighted colors and
 * the peak coverage, the coverage sum (in its blue channel for numeric
 * colors, in the coverage layer for categorical ones) and the line on top.
 * Selected layers contribute all of it, deselected ones their coverage sum
 * and peak.
 */
const ACCUMULATE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
precision highp usampler2D;
uniform sampler2DArray u_blockSums;
uniform sampler2DArray u_blockCoverage;
uniform sampler2DArray u_blockOnTop;
uniform usampler2D u_blockStates;
uniform int u_layers;
uniform bool u_valueColors;
uniform bool u_withOnTop;
layout(location = 0) out vec4 selectedSums;
layout(location = 1) out vec4 coverageSums;
layout(location = 2) out vec4 onTop;
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec4 selected = vec4(0.0);
  float selectedCoverage = 0.0;
  float contextCoverage = 0.0;
  float contextPeak = 0.0;
  float key = 0.0;
  for (int layer = 0; layer < u_layers; ++layer) {
    uint state = texelFetch(u_blockStates, ivec2(layer, 0), 0).r;
    if (state == ${LAYER_SKIPPED}u) {
      continue;
    }
    vec4 sums = texelFetch(u_blockSums, ivec3(pixel, layer), 0);
    float coverage = u_valueColors ? sums.b : texelFetch(u_blockCoverage, ivec3(pixel, layer), 0).r;
    if (state == ${LAYER_SELECTED}u) {
      selected = vec4(selected.rgb + sums.rgb, max(selected.a, sums.a));
      selectedCoverage += coverage;
      if (u_withOnTop) {
        key = max(key, texelFetch(u_blockOnTop, ivec3(pixel, layer), 0).a);
      }
    } else {
      contextCoverage += coverage;
      contextPeak = max(contextPeak, sums.a);
    }
  }
  selectedSums = selected;
  coverageSums = vec4(selectedCoverage, contextCoverage, 0.0, contextPeak);
  onTop = vec4(0.0, 0.0, 0.0, key);
}
`;

/** Texture units of the layers, above those of webgl.ts's line and density passes. */
const BLOCK_UNITS = { sums: 9, coverage: 10, onTop: 11, states: 12 } as const;

/**
 * Float array textures with one layer per block or half slot. Layers hold the
 * line pass's targets 0 to 2 (see DENSITY_FRAGMENT_SHADER) for rows drawn as
 * if all were selected: sums always, the coverage sum for categorical colors
 * only (numeric colors carry it in the sums' blue channel), and the line on
 * top for the "lowest" and "highest" color modes only. One target per
 * fragment for numeric colors also halves the blending the line pass's two
 * targets take.
 */
export class BlockLayers {
  readonly sums: WebGLTexture;
  readonly coverage: WebGLTexture | null;
  readonly onTop: WebGLTexture | null;
  readonly states: WebGLTexture;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
    readonly layers: number,
    readonly valueColors: boolean,
    readonly withOnTop: boolean,
  ) {
    const created: WebGLTexture[] = [];
    const texture = (target: number): WebGLTexture => {
      const texture = gl.createTexture();
      if (texture === null) throw new Error("Could not create a block layer texture");
      created.push(texture);
      gl.bindTexture(target, texture);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return texture;
    };
    const layered = (format: number): WebGLTexture => {
      const created = texture(gl.TEXTURE_2D_ARRAY);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, format, width, height, layers);
      return created;
    };
    try {
      this.sums = layered(gl.RGBA32F);
      this.coverage = valueColors ? null : layered(gl.R32F);
      this.onTop = withOnTop ? layered(gl.RGBA32F) : null;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      this.states = texture(gl.TEXTURE_2D);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, layers, 1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      checkGl(gl, `allocating ${layers} block layers of ${width} x ${height}`);
    } catch (error) {
      for (const texture of created) gl.deleteTexture(texture);
      throw error;
    }
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.sums);
    if (this.coverage !== null) gl.deleteTexture(this.coverage);
    if (this.onTop !== null) gl.deleteTexture(this.onTop);
    gl.deleteTexture(this.states);
  }
}

/**
 * The framebuffer that draws into a layer and the pass that adds layers up,
 * made once per context: every set of layers shares them.
 */
export class BlockPasses {
  private readonly framebuffer: WebGLFramebuffer;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly program: WebGLProgram;
  private readonly locations: Map<string, WebGLUniformLocation | null>;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const framebuffer = gl.createFramebuffer();
    const vertexArray = gl.createVertexArray();
    try {
      if (framebuffer === null) throw new Error("Could not create the block framebuffer");
      if (vertexArray === null) throw new Error("Could not create the block vertex array");
      this.program = linkProgram(
        gl,
        ACCUMULATE_VERTEX_SHADER,
        ACCUMULATE_FRAGMENT_SHADER,
        "Block accumulation",
      );
    } catch (error) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteVertexArray(vertexArray);
      throw error;
    }
    this.framebuffer = framebuffer;
    this.vertexArray = vertexArray;
    this.locations = new Map(
      [
        "u_blockSums",
        "u_blockCoverage",
        "u_blockOnTop",
        "u_blockStates",
        "u_layers",
        "u_valueColors",
        "u_withOnTop",
      ].map((name) => [name, gl.getUniformLocation(this.program, name)]),
    );
  }

  /**
   * Binds layer `layer` as the line pass's targets, for drawing rows as if all
   * were selected: onto what it holds, or with `clear`, from nothing.
   */
  bindLayer(layers: BlockLayers, layer: number, clear: boolean): void {
    const gl = this.gl;
    if (!(layer >= 0 && layer < layers.layers)) {
      throw new Error(`No block layer ${layer} of ${layers.layers}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, layers.sums, 0, layer);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, layers.coverage, 0, layer);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, layers.onTop, 0, layer);
    gl.drawBuffers([
      gl.COLOR_ATTACHMENT0,
      layers.coverage === null ? gl.NONE : gl.COLOR_ATTACHMENT1,
      layers.onTop === null ? gl.NONE : gl.COLOR_ATTACHMENT2,
    ]);
    gl.viewport(0, 0, layers.width, layers.height);
    if (!clear) return;
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    if (layers.coverage !== null) gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    if (layers.onTop !== null) gl.clearBufferfv(gl.COLOR, 2, [0, 0, 0, 0]);
  }

  /**
   * Adds every layer `states` does not skip to the bound density framebuffer,
   * which already holds any partly selected blocks drawn directly; the caller
   * sets its blending.
   */
  accumulate(layers: BlockLayers, states: Uint8Array): void {
    const gl = this.gl;
    if (states.length !== layers.layers) {
      throw new Error(`${states.length} block states for ${layers.layers} layers`);
    }
    gl.activeTexture(gl.TEXTURE0 + BLOCK_UNITS.states);
    gl.bindTexture(gl.TEXTURE_2D, layers.states);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      layers.layers,
      1,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      states,
    );
    for (const [unit, texture] of [
      [BLOCK_UNITS.sums, layers.sums],
      [BLOCK_UNITS.coverage, layers.coverage ?? layers.sums],
      [BLOCK_UNITS.onTop, layers.onTop ?? layers.sums],
    ] as const) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    }
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a React hook.
    gl.useProgram(this.program);
    const uniform = (name: string) => this.locations.get(name) ?? null;
    gl.uniform1i(uniform("u_blockSums"), BLOCK_UNITS.sums);
    gl.uniform1i(uniform("u_blockCoverage"), BLOCK_UNITS.coverage);
    gl.uniform1i(uniform("u_blockOnTop"), BLOCK_UNITS.onTop);
    gl.uniform1i(uniform("u_blockStates"), BLOCK_UNITS.states);
    gl.uniform1i(uniform("u_layers"), layers.layers);
    gl.uniform1i(uniform("u_valueColors"), layers.valueColors ? 1 : 0);
    gl.uniform1i(uniform("u_withOnTop"), layers.withOnTop ? 1 : 0);
    gl.bindVertexArray(this.vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    for (const unit of Object.values(BLOCK_UNITS)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }
}
