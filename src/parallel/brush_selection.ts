import type { FilterRange } from "../filters";
import type { Datapoint } from "../types";
import type { BrushedAxes, BrushMessage, BrushReply } from "./brush_types";
import { type AxisSelection, BrushMasks } from "./selection";
import { columnKey, selectionColumn } from "./selection_columns";
import type { BrushVersion } from "./selection_delta";
import type { SelectionColumn } from "./selection_index";

/** What a selection request returns: its own copies, which later requests leave alone. */
export interface SelectionResult {
  /** 1 for each row inside the brushes of every brushed axis, in row order. */
  mask: Uint8Array;
  count: number;
  /** The rows every brushed axis but the request's focus passes; null without a focus. */
  passing: { dimension: string; rows: Uint8Array } | null;
  /** Whether this request, or one it replaced before it was sent, publishes its selection. */
  publish: boolean;
  /**
   * The version the render worker holds this selection as (see attachRender),
   * for frames to name instead of sending it; null when it holds none.
   */
  version: BrushVersion | null;
}

interface Request {
  id: number;
  axes: BrushedAxes;
  focus: string | null;
  publish: boolean;
  resolve: (result: SelectionResult | null) => void;
}

export interface BrushWorkers {
  brush: Worker;
  index: Worker;
}

async function inlineWorkers(): Promise<BrushWorkers | null> {
  if (typeof Worker === "undefined" || typeof MessageChannel === "undefined") return null;
  // The workers are embedded in standalone HTML, never fetched from a sibling file.
  const [{ default: BrushWorker }, { default: IndexWorker }] = await Promise.all([
    import("./brush_entry?worker&inline"),
    import("./selection_entry?worker&inline"),
  ]);
  return {
    brush: new BrushWorker({ name: "hiplot-brush" }),
    index: new IndexWorker({ name: "hiplot-sort" }),
  };
}

/**
 * The page's side of the brushes' selection, computed on the brush worker
 * (see connectBrushWorker), which sorts columns through a worker of its own.
 * Columns are read from the rows once each and sent; requests then send only
 * brush ranges. One request is in flight at a time: a request made meanwhile
 * replaces the one waiting, whose promise resolves to null, so the worker
 * always works on the newest brushes. Results arrive in request order.
 *
 * Without workers, or once they fail (the error is rethrown), the same
 * selection runs on the page.
 */
export class BrushSelection {
  private workers: BrushWorkers | null = null;
  private starting = false;
  private local: BrushMasks | null = null;
  private disposed = false;
  private nextId = 0;
  /** The newest request whose result was delivered: older replies are stale. */
  private deliveredId = 0;
  /** Columns built for the worker, sent once it starts. */
  private readonly unsent = new Map<string, { range: FilterRange; column: SelectionColumn }>();
  private readonly sent = new Set<string>();
  private inFlight: Request | null = null;
  private queued: Request | null = null;
  private readonly preparing = new Map<number, { axes: BrushedAxes; resolve: () => void }>();
  private passing: { dimension: string; rows: Uint8Array } | null = null;
  /** A result's mask the caller no longer reads, sent with the next request for its result. */
  private spare: Uint8Array | null = null;
  /** The render worker's port and link, until the brush worker starts and takes them. */
  private renderPort: { port: MessagePort; link: number } | null = null;
  private workerWasmBytes = 0;

  constructor(
    readonly rows: ReadonlyArray<Datapoint>,
    private readonly createWorkers: () => Promise<BrushWorkers | null> = inlineWorkers,
  ) {}

  /** Memory the sorting kernels hold, as the brush worker last reported it. */
  get wasmMemoryBytes(): number {
    return this.local?.wasmMemoryBytes ?? this.workerWasmBytes;
  }

  /** Whether the selection runs on the page: without workers, or since they failed. */
  get onPage(): boolean {
    return this.local !== null;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Cannot select with a disposed brush selection");
  }

  /**
   * The rows inside the brushes of every axis of `selections`, and those
   * every axis but `focus` passes. No brush selects every row at once.
   */
  select(
    selections: ReadonlyMap<string, AxisSelection>,
    focus: string | null,
    publish: boolean,
  ): Promise<SelectionResult | null> {
    this.assertUsable();
    const axes: BrushedAxes = Array.from(selections, ([dimension, ranges]) => [
      dimension,
      ranges.map((range) => ({ ...range })),
    ]);
    return new Promise((resolve) => {
      const request: Request = { id: ++this.nextId, axes, focus, publish, resolve };
      if (axes.length === 0) {
        this.supersedeWaiting(request);
        this.deliveredId = request.id;
        resolve(this.everyRow(focus, request.publish));
        return;
      }
      if (this.local !== null) {
        this.deliveredId = request.id;
        resolve(this.selectOnPage(this.local, request));
        return;
      }
      this.supersedeWaiting(request);
      for (const [, ranges] of axes) for (const range of ranges) this.columnFor(range);
      this.queued = request;
      this.start();
      this.sendQueued();
    });
  }

  /** Builds and sends `range`'s column ahead of its first brush, which then reads no row. */
  warm(range: FilterRange): void {
    this.assertUsable();
    if (this.local !== null) {
      this.local.warm([range]);
      return;
    }
    this.columnFor(range);
    this.start();
  }

  /** Resolves once the columns these selections brush are sorted. */
  prepare(selections: ReadonlyMap<string, AxisSelection>): Promise<void> {
    this.assertUsable();
    if (this.local !== null) return this.local.prepare(selections);
    const axes: BrushedAxes = Array.from(selections);
    for (const [, ranges] of axes) for (const range of ranges) this.columnFor(range);
    return new Promise<void>((resolve) => {
      const id = ++this.nextId;
      this.preparing.set(id, { axes, resolve });
      this.start();
      if (this.workers !== null) this.post({ kind: "prepare", id, axes });
    });
  }

  /**
   * Links the render worker (see RenderWorker.attachBrush): from now on the
   * brush worker sends it every selection, and results say which version it
   * holds them as. On the page, nothing is sent and the port closes.
   */
  attachRender(port: MessagePort, link: number): void {
    this.assertUsable();
    this.renderPort?.port.close();
    if (this.local !== null) {
      port.close();
      return;
    }
    this.renderPort = { port, link };
    this.sendRenderPort();
  }

  private sendRenderPort(): void {
    const render = this.renderPort;
    if (render === null || this.workers === null) return;
    this.renderPort = null;
    this.post({ kind: "render", ...render }, [render.port]);
  }

  /**
   * Hands back a result's mask the caller will not read again: the worker
   * writes a later selection into it instead of allocating one per move.
   */
  recycle(mask: Uint8Array): void {
    if (mask.length !== this.rows.length) {
      throw new Error(
        `Recycled a mask of ${mask.length} rows; brushes select among ${this.rows.length}`,
      );
    }
    if (this.local === null) this.spare = mask;
  }

  /** The selected rows, in their original order. Materializing rows is O(rows). */
  selectedRows(mask: Uint8Array): Datapoint[] {
    return this.rows.filter((_, index) => mask[index] === 1);
  }

  /** A request waiting to be sent: the newer one replaces it, keeping its publication. */
  private supersedeWaiting(request: Request): void {
    const waiting = this.queued;
    if (waiting === null) return;
    this.queued = null;
    request.publish ||= waiting.publish;
    waiting.resolve(null);
  }

  private everyRow(focus: string | null, publish: boolean): SelectionResult {
    const all = () => new Uint8Array(this.rows.length).fill(1);
    return {
      mask: all(),
      count: this.rows.length,
      passing: focus === null ? null : { dimension: focus, rows: all() },
      publish,
      version: null,
    };
  }

  private selectOnPage(masks: BrushMasks, request: Request): SelectionResult {
    const mask = masks.select(new Map(request.axes)).slice();
    return {
      mask,
      count: masks.selectedCount,
      passing:
        request.focus === null
          ? null
          : // Kept while the other axes keep their brushes: the render worker resends changed rows only.
            { dimension: request.focus, rows: masks.passingExcept(request.focus) },
      publish: request.publish,
      version: null,
    };
  }

  private columnFor(range: FilterRange): void {
    const key = columnKey(range);
    if (this.sent.has(key) || this.unsent.has(key)) return;
    this.unsent.set(key, { range: { ...range }, column: selectionColumn(this.rows, range) });
    this.sendColumns();
  }

  private sendColumns(): void {
    if (this.workers === null) return;
    for (const [key, { range, column }] of this.unsent) {
      const transfer =
        column.kind === "numeric"
          ? [column.values.buffer, column.missing.buffer]
          : [column.codes.buffer];
      this.post({ kind: "column", range, column }, transfer);
      this.sent.add(key);
    }
    this.unsent.clear();
  }

  private sendQueued(): void {
    const request = this.queued;
    if (request === null || this.inFlight !== null || this.workers === null) return;
    this.queued = null;
    this.inFlight = request;
    const spare = this.spare;
    this.spare = null;
    this.post(
      { kind: "select", id: request.id, axes: request.axes, focus: request.focus, spare },
      spare === null ? [] : [spare.buffer],
    );
  }

  private post(message: BrushMessage, transfer: Transferable[] = []): void {
    try {
      this.workers?.brush.postMessage(message, transfer);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Starts the workers ahead of any request, so their scripts load while the
   * page is idle instead of during a brush's first move.
   */
  start(): void {
    this.assertUsable();
    if (this.workers !== null || this.starting || this.local !== null) return;
    this.starting = true;
    void this.createWorkers()
      .then((workers) => {
        this.starting = false;
        if (this.disposed) {
          workers?.brush.terminate();
          workers?.index.terminate();
          return;
        }
        if (workers === null) this.runOnPage();
        else this.connect(workers);
      })
      .catch((error: unknown) => {
        this.starting = false;
        if (!this.disposed) this.fail(error);
      });
  }

  private connect(workers: BrushWorkers): void {
    this.workers = workers;
    const { brush, index } = workers;
    brush.onmessage = ({ data }: MessageEvent<BrushReply>) => this.receive(data);
    brush.onerror = (event) => this.fail(new Error(`Brush worker failed: ${event.message}`));
    brush.onmessageerror = () => this.fail(new Error("The brush worker sent an unreadable reply"));
    index.onerror = (event) => this.fail(new Error(`Selection worker failed: ${event.message}`));
    const channel = new MessageChannel();
    index.postMessage({ port: channel.port2 }, [channel.port2]);
    this.post({ kind: "init", rowCount: this.rows.length, index: channel.port1 }, [channel.port1]);
    this.sendRenderPort();
    this.sendColumns();
    for (const [id, { axes }] of this.preparing) this.post({ kind: "prepare", id, axes });
    this.sendQueued();
  }

  private receive(reply: BrushReply): void {
    // Replies queued before a failure terminated the workers change nothing.
    if (this.disposed || this.local !== null) return;
    if (reply.kind === "error") {
      this.fail(new Error(reply.message));
      return;
    }
    this.workerWasmBytes = reply.wasmMemoryBytes;
    if (reply.kind === "prepared") {
      const prepared = this.preparing.get(reply.id);
      if (prepared === undefined) {
        this.fail(new Error("The brush worker prepared an unexpected request"));
        return;
      }
      this.preparing.delete(reply.id);
      prepared.resolve();
      return;
    }
    const request = this.inFlight;
    if (request === null || request.id !== reply.id) {
      this.fail(new Error("The brush worker returned an unexpected selection"));
      return;
    }
    this.inFlight = null;
    if (request.focus !== null && reply.passing !== null) {
      this.passing = { dimension: request.focus, rows: reply.passing };
    }
    // A request without brushes, answered on the page, may have overtaken this one.
    if (request.id < this.deliveredId) {
      request.resolve(null);
    } else {
      this.deliveredId = request.id;
      request.resolve({
        mask: reply.mask,
        count: reply.count,
        passing: this.passing?.dimension === request.focus ? this.passing : null,
        publish: request.publish,
        version: reply.link === null ? null : { link: reply.link, version: reply.id },
      });
    }
    this.sendQueued();
  }

  private fail(error: unknown): void {
    if (this.local !== null || this.disposed) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    setTimeout(() => {
      throw failure;
    }, 0);
    this.runOnPage();
  }

  /** Moves the selection onto the page, answering the requests the workers left. */
  private runOnPage(): void {
    this.workers?.brush.terminate();
    this.workers?.index.terminate();
    this.workers = null;
    this.renderPort?.port.close();
    this.renderPort = null;
    const rows = this.rows;
    const local = new BrushMasks(rows.length, (range) => selectionColumn(rows, range), null);
    this.local = local;
    this.unsent.clear();
    this.sent.clear();
    // The page scans columns: nothing is left to sort.
    for (const prepared of this.preparing.values()) prepared.resolve();
    this.preparing.clear();
    const inFlight = this.inFlight;
    const queued = this.queued;
    this.inFlight = null;
    this.queued = null;
    const newest = queued ?? inFlight;
    if (newest !== null && newest.id > this.deliveredId) {
      if (queued !== null) {
        queued.publish ||= inFlight?.publish ?? false;
        inFlight?.resolve(null);
      }
      this.deliveredId = newest.id;
      newest.resolve(this.selectOnPage(local, newest));
    } else {
      inFlight?.resolve(null);
      queued?.resolve(null);
    }
  }

  /** Releases the workers; requests still waiting resolve to null. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.workers?.brush.terminate();
    this.workers?.index.terminate();
    this.workers = null;
    this.inFlight?.resolve(null);
    this.queued?.resolve(null);
    this.inFlight = null;
    this.queued = null;
    for (const prepared of this.preparing.values()) prepared.resolve();
    this.preparing.clear();
    this.unsent.clear();
    this.renderPort?.port.close();
    this.renderPort = null;
    this.local?.dispose();
  }
}
