/**
 * A brush selection the render worker holds: the page's request `version`,
 * sent over the channel `link` (versions restart with each brush selection,
 * so a version alone names nothing).
 */
export interface BrushVersion {
  link: number;
  version: number;
}

/**
 * A brush selection as the brush worker sends it to the render worker: the
 * 32-row words of its bits that changed since the last one it sent, or every
 * word, with its link, version and selected count.
 */
export interface SelectionDelta {
  kind: "selection";
  link: number;
  version: number;
  rowCount: number;
  count: number;
  /** The changed words' indices, each one's bits in `bits`; null when `bits` holds every word. */
  words: Uint32Array | null;
  bits: Uint32Array;
}

/**
 * The delta from `previous` to `current` bits: changed words only while
 * their indices and bits take less room than every word.
 */
export function selectionDelta(
  previous: Uint32Array | null,
  current: Uint32Array,
  selection: Pick<SelectionDelta, "link" | "version" | "rowCount" | "count">,
): SelectionDelta {
  if (previous !== null && previous.length !== current.length) {
    throw new Error("A selection delta compares bits of different row counts");
  }
  let changed = 0;
  if (previous !== null) {
    for (let word = 0; word < current.length; ++word) {
      if (previous[word] !== current[word]) ++changed;
    }
  }
  if (previous === null || 2 * changed >= current.length) {
    return { kind: "selection", ...selection, words: null, bits: current.slice() };
  }
  const words = new Uint32Array(changed);
  const bits = new Uint32Array(changed);
  let next = 0;
  for (let word = 0; word < current.length; ++word) {
    if (previous[word] === current[word]) continue;
    words[next] = word;
    bits[next] = current[word];
    ++next;
  }
  return { kind: "selection", ...selection, words, bits };
}

/**
 * The render worker's copy of the brush selection, built from deltas: one
 * flag per row for the renderers, written only where a delta changed bits.
 */
export class DeltaSelection {
  readonly mask: Uint8Array;
  private readonly bits: Uint32Array;
  private applied = false;
  version = 0;
  count = 0;

  constructor(
    readonly link: number,
    readonly rowCount: number,
  ) {
    this.mask = new Uint8Array(rowCount);
    this.bits = new Uint32Array(Math.ceil(rowCount / 32));
  }

  /** Whether a selection was applied: before the first, there is none to draw. */
  get ready(): boolean {
    return this.applied;
  }

  /** Whether this selection is `named`'s, at its version or a newer one. */
  holds(named: BrushVersion): boolean {
    return this.applied && named.link === this.link && this.version >= named.version;
  }

  apply(delta: SelectionDelta): void {
    if (delta.link !== this.link) {
      throw new Error(`A selection of link ${delta.link} reached link ${this.link}`);
    }
    if (delta.rowCount !== this.rowCount) {
      throw new Error(`A selection of ${delta.rowCount} rows for ${this.rowCount} rows`);
    }
    if (delta.version <= this.version) {
      throw new Error(`Selection ${delta.version} arrived after ${this.version}`);
    }
    if (delta.words === null) {
      if (delta.bits.length !== this.bits.length) throw new Error("A full selection lacks words");
      for (let word = 0; word < this.bits.length; ++word) this.setWord(word, delta.bits[word]);
    } else {
      if (!this.applied) throw new Error("A selection's changes arrived before the selection");
      for (let index = 0; index < delta.words.length; ++index) {
        this.setWord(delta.words[index], delta.bits[index]);
      }
    }
    this.applied = true;
    this.version = delta.version;
    this.count = delta.count;
  }

  private setWord(word: number, bits: number): void {
    let changed = (bits ^ this.bits[word]) >>> 0;
    this.bits[word] = bits;
    const base = word * 32;
    while (changed !== 0) {
      const bit = 31 - Math.clz32(changed & -changed);
      this.mask[base + bit] = (bits >>> bit) & 1;
      changed = (changed & (changed - 1)) >>> 0;
    }
  }
}
