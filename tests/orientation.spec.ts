import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

interface OrientationProbe {
  isInverted: (dimension: string) => boolean;
  yscale: { [dimension: string]: { domain: () => unknown[] } };
  brushes: Map<string, unknown>;
  autoscroll: { active: boolean } | null;
  scroller_ref: { current: HTMLDivElement | null };
}
interface HiPlotWindow {
  hiplot_last_instance?: { parallelPlot: () => OrientationProbe | null };
}

/** Uploads rows as a CSV file, with the given URL state, and waits for the axes. */
async function upload(page: Page, rows: (string | number)[][], state = ""): Promise<void> {
  await page.goto(`/?provider=upload${state}`);
  await page.locator("input[type=file]").setInputFiles({
    name: "trials.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(rows.map((row) => row.join(",")).join("\n")),
  });
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

/**
 * Sixty trials: loss falls as score rises, lr rises with it, and the optimizer
 * goes from sgd to adam to rmsprop as score rises.
 */
function trials(): (string | number)[][] {
  const optimizers = ["sgd", "adam", "rmsprop"];
  const rows: (string | number)[][] = [["score", "loss", "lr", "optimizer"]];
  for (let i = 0; i < 60; ++i) {
    rows.push([
      i / 60,
      1 - i / 60 + (i % 5) * 0.003,
      0.001 * (1 + i),
      optimizers[Math.floor(i / 20)],
    ]);
  }
  return rows;
}

const colorByScore = `&hip.color_by=${encodeURIComponent('"score"')}`;

function probe<T>(page: Page, read: (pp: OrientationProbe) => T): Promise<T> {
  return page.evaluate(
    ([source]) => {
      const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
      if (!pp) {
        throw new Error("No parallel plot");
      }
      return new Function("pp", `return (${source})(pp);`)(pp) as T;
    },
    [read.toString()],
  );
}

function label(page: Page, dimension: string) {
  return page.locator(`svg text.pplot-label[data-dimension="${dimension}"]`);
}

test("axes put the values of high colors at the top, and categories follow the color", async ({
  page,
}) => {
  await upload(page, trials(), colorByScore);
  expect(await probe(page, (pp) => pp.isInverted("loss"))).toBe(true);
  expect(await probe(page, (pp) => pp.isInverted("lr"))).toBe(false);
  expect(await probe(page, (pp) => pp.isInverted("score"))).toBe(false);
  expect(await probe(page, (pp) => pp.yscale.optimizer.domain())).toEqual([
    "sgd",
    "adam",
    "rmsprop",
  ]);
  await expect(label(page, "loss")).toHaveCSS("text-decoration-line", "underline");
  await expect(label(page, "lr")).toHaveCSS("text-decoration-line", "none");
});

test("an axis flipped by hand keeps its orientation after a reload", async ({ page }) => {
  await upload(page, trials(), colorByScore);
  await label(page, "loss").click();
  await expect.poll(() => probe(page, (pp) => pp.isInverted("loss"))).toBe(false);
  await expect(label(page, "loss")).toHaveCSS("text-decoration-line", "none");
  await expect.poll(() => decodeURIComponent(page.url())).toContain('upright=["loss"]');

  await label(page, "loss").click();
  await expect.poll(() => probe(page, (pp) => pp.isInverted("loss"))).toBe(true);
  await label(page, "lr").click();
  await expect.poll(() => probe(page, (pp) => pp.isInverted("lr"))).toBe(true);

  await page.reload();
  await page.locator("input[type=file]").setInputFiles({
    name: "trials.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      trials()
        .map((row) => row.join(","))
        .join("\n"),
    ),
  });
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  expect(await probe(page, (pp) => pp.isInverted("lr"))).toBe(true);
  expect(await probe(page, (pp) => pp.isInverted("loss"))).toBe(true);
});

test("coloring by another column turns the axes, and drops brushes of reordered categories", async ({
  page,
}) => {
  const brushes = encodeURIComponent(
    JSON.stringify({
      optimizer: [{ categories: ["sgd"] }],
      lr: [{ min: 0.01, max: 0.03, include_infnans: false }],
    }),
  );
  await upload(page, trials(), `${colorByScore}&hip.PARALLEL_PLOT.brushes=${brushes}`);
  expect(await probe(page, (pp) => Array.from(pp.brushes.keys()).sort())).toEqual([
    "lr",
    "optimizer",
  ]);

  await label(page, "loss").click({ button: "right" });
  await page.getByText("Use for coloring").click();

  await expect.poll(() => probe(page, (pp) => pp.isInverted("score"))).toBe(true);
  expect(await probe(page, (pp) => pp.isInverted("loss"))).toBe(false);
  expect(await probe(page, (pp) => pp.yscale.optimizer.domain())).toEqual([
    "rmsprop",
    "adam",
    "sgd",
  ]);
  await expect(label(page, "score")).toHaveCSS("text-decoration-line", "underline");
  expect(await probe(page, (pp) => Array.from(pp.brushes.keys()))).toEqual(["lr"]);
});

test.describe("middle-click autoscroll", () => {
  /** Forty columns: more axes than fit the plot. */
  function wide(): (string | number)[][] {
    const header = Array.from({ length: 40 }, (_, i) => `metric_${i}`);
    const rows = Array.from({ length: 30 }, (_, r) => header.map((_, c) => (r * (c + 3)) % 31));
    return [header, ...rows];
  }

  async function plotCenter(page: Page): Promise<{ x: number; y: number }> {
    const box = await page.getByTestId("pplot-scroller").boundingBox();
    if (box === null) {
      throw new Error("The axes fit the plot: no scrollbar");
    }
    return { x: box.x + box.width / 2, y: box.y - 150 };
  }

  const scrollLeft = (page: Page) => probe(page, (pp) => pp.scroller_ref.current?.scrollLeft ?? 0);
  const active = (page: Page) => probe(page, (pp) => pp.autoscroll?.active ?? false);

  test("holding the middle button and moving right scrolls the axes until release", async ({
    page,
  }) => {
    await upload(page, wide());
    const center = await plotCenter(page);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(center.x + 120, center.y, { steps: 4 });
    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(50);
    await page.mouse.up({ button: "middle" });
    expect(await active(page)).toBe(false);
    const stopped = await scrollLeft(page);
    await page.waitForTimeout(150);
    expect(await scrollLeft(page)).toBe(stopped);
  });

  test("a middle click without moving keeps scrolling until the next click", async ({ page }) => {
    await upload(page, wide());
    const center = await plotCenter(page);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.up({ button: "middle" });
    expect(await active(page)).toBe(true);
    await page.mouse.move(center.x + 120, center.y, { steps: 4 });
    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(50);
    await page.mouse.down();
    await page.mouse.up();
    expect(await active(page)).toBe(false);
  });
});
