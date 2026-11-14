import type { Locator, Page } from "@playwright/test";
import type { HiPlot } from "../src/component";

/**
 * Lines draw on the render worker wherever a canvas can hand its control to a
 * worker; without that the plot draws on its page's renderer. Tests of that
 * renderer remove the hand-over before the page loads. OffscreenCanvas stays,
 * so the page's continuous density keeps its GPU kernel.
 */
export async function useDirectRenderer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "transferControlToOffscreen", {
      value: undefined,
      configurable: true,
    });
  });
}

/**
 * Hides WebGL2 from the page's canvases and from every worker it starts, as in
 * a browser without it: each worker runs its script once WebGL2 is hidden.
 */
export async function hideWebGL2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const hide = (): void => {
      type Canvas = { prototype: { getContext: (kind: string, options?: unknown) => unknown } };
      const scope = globalThis as unknown as Record<string, Canvas | undefined>;
      // Workers have no HTMLCanvasElement.
      for (const name of ["HTMLCanvasElement", "OffscreenCanvas"]) {
        const canvas = scope[name];
        if (canvas === undefined) continue;
        const getContext = canvas.prototype.getContext;
        canvas.prototype.getContext = function (this: unknown, kind, options) {
          return kind === "webgl2" ? null : getContext.call(this, kind, options);
        };
      }
    };
    hide();
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        const prelude = `(${hide.toString()})();
importScripts(${JSON.stringify(String(url))});`;
        super(URL.createObjectURL(new Blob([prelude], { type: "text/javascript" })), options);
      }
    };
  });
}

/** A page given `shownPixels` by exposeShownPixels. */
export interface ShownPixelsWindow {
  /**
   * The premultiplied RGBA bytes `canvas` shows, top row first, at its size;
   * throws when that is not `size`, as when an image was shown scaled.
   */
  shownPixels: (canvas: HTMLCanvasElement, size?: { width: number; height: number }) => Uint8Array;
}

/**
 * Gives every document the page loads `window.shownPixels`. The render worker
 * shows its frames on its own canvas, the only place their pixels remain;
 * reading them through WebGL keeps the premultiplied bytes the canvas holds,
 * which a 2D canvas's unpremultiplied readback would round.
 */
export async function exposeShownPixels(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let reader: WebGL2RenderingContext | null = null;
    (window as unknown as ShownPixelsWindow).shownPixels = (canvas, size) => {
      if (size !== undefined && (canvas.width !== size.width || canvas.height !== size.height)) {
        throw new Error(
          `The canvas shows ${canvas.width}x${canvas.height} pixels, not ${size.width}x${size.height}`,
        );
      }
      reader ??= document.createElement("canvas").getContext("webgl2");
      const gl = reader;
      if (gl === null) throw new Error("Missing WebGL2 for pixel readback");
      const texture = gl.createTexture();
      const framebuffer = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      return pixels;
    };
  });
}

/**
 * Waits for the plot's render worker, which draws from the first frame, to
 * start and finish the frames it was sent.
 */
export async function warmParallelWorker(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const win = window as unknown as {
      __parallelProbe?: { instance: HiPlot };
      hiplot_last_instance?: HiPlot;
    };
    const plot = (win.__parallelProbe?.instance ?? win.hiplot_last_instance)?.parallelPlot();
    return plot && plot.worker?.presents === true && !plot.linesBusy;
  });
}

export async function loadDemo(page: Page, query = ""): Promise<void> {
  await page.goto(`/${query}`);
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

/**
 * Scrolls the parallel plot's axes to their right end, where the axes drawn
 * first in the DOM sit. The plot scrolls virtually (it draws what is in view),
 * so Playwright's scrollIntoViewIfNeeded cannot reach them.
 */
export async function scrollAxesToEnd(page: Page): Promise<void> {
  await page.getByTestId("pplot-scroller").evaluate((scroller) => {
    scroller.scrollLeft = scroller.scrollWidth;
  });
  await page.waitForTimeout(100);
}

/** The button of a scatter panel's axis ("X", "Y", "Z"), named "X: <column>". */
export const axisButton = (panel: Locator, axis: string): Locator =>
  panel.getByTestId(`axis-picker-${axis.toLowerCase()}`);

/** Picks `column` (null for None) on an axis of a scatter panel, from its list. */
export async function pickColumn(
  panel: Locator,
  axis: string,
  column: string | null,
): Promise<void> {
  await axisButton(panel, axis).click();
  await panel
    .getByRole("dialog", { name: `Column on ${axis}` })
    .getByRole("option", { name: column ?? "None", exact: true })
    .click();
}
