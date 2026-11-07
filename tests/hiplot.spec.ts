import { test, expect } from "@playwright/test";

async function loadDemo(page, uri = "demo") {
  if (process.env.PW_LOG) {
    page.on("console", (msg) => {
      console.log(`[console:${msg.type()}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => {
      console.log(`[pageerror] ${err.message}`);
    });
  }
  await page.goto("/");
  await page.waitForFunction(() => (window as any).hiplot?.render, { timeout: 15000 });
  await expect(page.locator("#hiplot_element_id")).toBeVisible();
  await expect(page.locator(".hip_thm--light, .hip_thm--dark")).toBeVisible();
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await expect(input).toBeVisible();
  await input.fill(uri);
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await expect(page.locator("text=Loading HiPlot...")).toHaveCount(0);
}

test("renders HiPlot on the default page", async ({ page }) => {
  await loadDemo(page);
});

test("datatable renders with rows", async ({ page }) => {
  await loadDemo(page);
  await expect(page.locator("table.sample-rows-table")).toBeVisible();
  const rowLocator = page.locator("table.sample-rows-table tbody tr");
  await expect.poll(async () => rowLocator.count(), { timeout: 20000 }).toBeGreaterThan(0);
});

test("respects hip.dark query parameter", async ({ page }) => {
  await page.goto("/?hip.dark=true");
  await expect(page.locator(".hip_thm--dark")).toBeVisible();

  await page.goto("/?hip.dark=false");
  await expect(page.locator(".hip_thm--light")).toBeVisible();
});

test("respects hip.dark=auto and tracks prefers-color-scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/?hip.dark=auto");
  await expect(page.locator(".hip_thm--dark")).toBeVisible();

  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator(".hip_thm--light")).toBeVisible();
});

test("ignores invalid hip.dark values", async ({ page }) => {
  await page.goto("/?hip.dark=banana");
  await expect(page.locator(".hip_thm--light")).toBeVisible();
});

test("defaults to auto dark mode when query param is absent", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator(".hip_thm--dark")).toBeVisible();
});

test("window.hiplot.render returns a HiPlot instance-compatible object", async ({ page }) => {
  await page.goto("/");
  const hasGetPlugin = await page.evaluate(() => {
    const instance = (window as any).hiplot_last_instance;
    return !!instance && typeof instance.getPlugin === "function";
  });
  expect(hasGetPlugin).toBeTruthy();
});

test("context menu opens on axis label right-click", async ({ page }) => {
  await loadDemo(page);
  const label = page.locator(".pplot-label").first();
  await expect(label).toBeVisible();
  await label.click({ button: "right" });
  await expect(page.locator(".context-menu.show")).toBeVisible();
});

test("dragging an axis changes its position", async ({ page }) => {
  await loadDemo(page);
  const dims = page.locator("svg g.dimension");
  const dimCount = await dims.count();
  expect(dimCount).toBeGreaterThan(2);

  const initialTransforms = await page.$$eval("svg g.dimension", (els) =>
    els.map((el) => el.getAttribute("transform")),
  );

  // Drag a middle axis to avoid edge constraints
  const midIdx = Math.floor(dimCount / 2);
  const label = dims.nth(midIdx).locator(".pplot-label").first();
  const box = await label.boundingBox();
  if (box) {
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 320, startY, { steps: 16 });
    await page.mouse.up();
  }

  await expect
    .poll(async () => {
      const afterTransforms = await page.$$eval("svg g.dimension", (els) =>
        els.map((el) => el.getAttribute("transform")),
      );
      return afterTransforms.some((t, i) => t !== initialTransforms[i]);
    })
    .toBeTruthy();
});

test("rapidly dragging axes back and forth does not crash", async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (err) => errors.push(err));

  await loadDemo(page);
  const dims = page.locator("svg g.dimension");
  const dimCount = await dims.count();
  expect(dimCount).toBeGreaterThan(2);

  // Pick a middle axis label to drag
  const midIdx = Math.floor(dimCount / 2);
  const label = dims.nth(midIdx).locator(".pplot-label").first();
  const box = await label.boundingBox();
  expect(box).toBeTruthy();

  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;

  // Perform several rapid back-and-forth drags.
  // Use minimal steps to create fastest possible event dispatch,
  // maximizing chances of React 19 batching drag/end setState calls.
  for (let round = 0; round < 5; round++) {
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Rapid zigzag across multiple columns
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(startX + 350, startY, { steps: 2 });
      await page.mouse.move(startX - 250, startY, { steps: 2 });
    }
    await page.mouse.up();
    // No pause between rounds - start next drag immediately
  }

  // Give React time to flush any deferred state updates and callbacks
  await page.waitForTimeout(500);

  expect(errors).toEqual([]);
});

test("brushing an axis updates selection count", async ({ page }) => {
  await loadDemo(page);
  const countLine = page.locator('div[style*="monospace"]').first();
  const extractCounts = async () => {
    const text = (await countLine.textContent()) ?? "";
    const match = text.match(/Selected:\s*(\d+)\s*\/\s*(\d+)/);
    if (!match) return { selected: NaN, total: NaN };
    return { selected: parseInt(match[1], 10), total: parseInt(match[2], 10) };
  };
  const before = await extractCounts();

  const overlay = page.locator("svg g.dimension .pplot-brush rect.overlay").first();
  const box = await overlay.boundingBox();
  if (box) {
    const x = box.x + box.width / 2;
    const y1 = box.y + box.height * 0.25;
    const y2 = box.y + box.height * 0.75;
    await page.mouse.move(x, y1);
    await page.mouse.down();
    await page.mouse.move(x, y2, { steps: 12 });
    await page.mouse.up();
  }

  await expect
    .poll(async () => {
      const after = await extractCounts();
      return !Number.isNaN(after.selected) && after.selected !== before.selected;
    })
    .toBeTruthy();
});

test("hide and restore axis via context menu", async ({ page }) => {
  await loadDemo(page);
  const dims = page.locator("svg g.dimension");
  const countBefore = await dims.count();
  expect(countBefore).toBeGreaterThan(2);

  const label = page.locator(".pplot-label").first();
  await label.click({ button: "right" });
  await expect(page.locator(".context-menu.show")).toBeVisible();

  const hideItem = page.locator(".context-menu .dropdown-item", { hasText: "Hide axis" });
  await hideItem.click();

  await expect
    .poll(async () => await page.locator("svg g.dimension").count())
    .toBe(countBefore - 1);

  // Restore from header button if available
  const restoreButton = page.locator('button[title="Restore hidden columns in parallel plot"]');
  if (await restoreButton.count()) {
    await restoreButton.first().click();
    await expect.poll(async () => await page.locator("svg g.dimension").count()).toBe(countBefore);
  }
});

test("distribution switches axes on menu selection", async ({ page }) => {
  await loadDemo(page);
  const labels = page.locator(".pplot-label");
  await expect(labels.first()).toBeVisible();
  const labelTexts = await labels.evaluateAll((nodes) =>
    nodes.map((node) => {
      const textParts = Array.from(node.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => (child.textContent || "").trim())
        .filter((text) => text.length > 0);
      return textParts.join(" ").trim();
    }),
  );
  const uniqueLabels = Array.from(new Set(labelTexts.filter((text) => text.length > 0)));
  expect(uniqueLabels.length).toBeGreaterThanOrEqual(2);
  const axis1 = uniqueLabels[0];
  const axis2 = uniqueLabels[1];
  const axis1Index = labelTexts.findIndex((text) => text === axis1);
  const axis2Index = labelTexts.findIndex((text) => text === axis2);
  expect(axis1Index).toBeGreaterThanOrEqual(0);
  expect(axis2Index).toBeGreaterThanOrEqual(0);

  await labels.nth(axis1Index).click({ button: "right" });
  await expect(page.locator(".context-menu.show")).toBeVisible();
  await page.locator(".context-menu .dropdown-item", { hasText: "View distribution" }).click();
  await expect(
    page.locator(`[data-testid="distribution-plot"][data-axis="${axis1}"]`),
  ).toBeVisible();

  await labels.nth(axis2Index).click({ button: "right" });
  await expect(page.locator(".context-menu.show")).toBeVisible();
  await page.locator(".context-menu .dropdown-item", { hasText: "View distribution" }).click();
  await expect(
    page.locator(`[data-testid="distribution-plot"][data-axis="${axis2}"]`),
  ).toBeVisible();
});

test("distribution categorical bars stay aligned with labels after keep/filter", async ({
  page,
}) => {
  await loadDemo(page, "demo_distribution_colors_deterministic");
  const labels = page.locator(".pplot-label");
  await expect(labels.first()).toBeVisible();
  const labelTexts = await labels.evaluateAll((nodes) =>
    nodes.map((node) => {
      const textParts = Array.from(node.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => (child.textContent || "").trim())
        .filter((text) => text.length > 0);
      return textParts.join(" ").trim();
    }),
  );
  const cAxisIndex = labelTexts.findIndex((text) => text === "c");
  expect(cAxisIndex).toBeGreaterThanOrEqual(0);

  await expect(page.locator('[data-testid="distribution-plot"][data-axis="c"]')).toBeVisible();

  const cDimension = page.locator("svg g.dimension").nth(cAxisIndex);
  const cOverlay = cDimension.locator(".pplot-brush rect.overlay").first();
  const greenTick = cDimension.locator(".tick text", { hasText: "green" }).first();
  const overlayBox = await cOverlay.boundingBox();
  const greenTickBox = await greenTick.boundingBox();
  expect(overlayBox).toBeTruthy();
  expect(greenTickBox).toBeTruthy();
  const x = overlayBox!.x + overlayBox!.width / 2;
  const y1 = greenTickBox!.y + 1;
  const y2 = greenTickBox!.y + greenTickBox!.height - 1;
  await page.mouse.move(x, y1);
  await page.mouse.down();
  await page.mouse.move(x, y2, { steps: 8 });
  await page.mouse.up();

  const keepButton = page.locator('button:has-text("Keep")').first();
  await expect(keepButton).toBeEnabled();
  await keepButton.click();
  await page.waitForTimeout(900);

  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const root = document.querySelector(
          '[data-testid="distribution-plot"][data-axis="c"]',
        ) as HTMLElement | null;
        if (!root) {
          return { ok: false, reason: "missing-distribution-root" };
        }
        const bars = Array.from(
          root.querySelectorAll('[data-testid="distribution-hist-all"] rect'),
        ).map((rect) => {
          const bb = (rect as SVGGraphicsElement).getBBox();
          return {
            area: bb.width * bb.height,
            sample: (rect.getAttribute("data-value-sample") || "").trim(),
          };
        });
        const nonEmpty = bars.filter((b) => Number.isFinite(b.area) && b.area > 1);
        if (nonEmpty.length === 0) {
          return { ok: false, reason: "no-non-empty-bars" };
        }
        if (!nonEmpty.every((b) => b.sample === "green")) {
          return {
            ok: false,
            reason: `non-green-samples:${nonEmpty.map((b) => b.sample).join(",")}`,
          };
        }
        return { ok: true, reason: "green" };
      });
    })
    .toEqual({ ok: true, reason: "green" });
});

test("plotxy y-axis tick labels are not clipped for large numeric ranges", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).hiplot?.render, { timeout: 15000 });
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await expect(input).toBeVisible();
  await input.fill("demo_plotxy_large_numeric");
  await input.press("Enter");
  await expect(page.locator("text=Loading HiPlot...")).toHaveCount(0);

  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const svg = Array.from(document.querySelectorAll("svg")).find((candidate) =>
          candidate.querySelector(".axis_render"),
        ) as SVGSVGElement | undefined;
        if (!svg) {
          return { ok: false, reason: "missing-xy-svg" };
        }
        const svgRect = svg.getBoundingClientRect();
        const yAxisGroup = Array.from(svg.querySelectorAll<SVGGElement>(".axis_render")).find(
          (g) => {
            const t = g.getAttribute("transform") || "";
            return /^translate\(([-\d.]+),0\)$/.test(t) && !t.startsWith("translate(0,");
          },
        );
        if (!yAxisGroup) {
          return { ok: false, reason: "missing-y-axis-group" };
        }
        const tickTexts = Array.from(yAxisGroup.querySelectorAll<SVGTextElement>(".tick text"));
        if (!tickTexts.length) {
          return { ok: false, reason: "missing-y-ticks" };
        }
        const minLeft = Math.min(...tickTexts.map((t) => t.getBoundingClientRect().left));
        return {
          ok: minLeft >= svgRect.left - 0.5,
          reason: `minLeft:${minLeft.toFixed(2)} svgLeft:${svgRect.left.toFixed(2)}`,
        };
      });
    })
    .toEqual({ ok: true, reason: expect.stringContaining("minLeft:") });
});

test("inverted axis orientation is preserved across keep/restore on another axis", async ({
  page,
}) => {
  await loadDemo(page);
  const result = await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const hiplot = (window as any).hiplot_last_instance;
    const pplot = hiplot?.plugins_ref?.PARALLEL_PLOT?.current;
    if (!hiplot || !pplot) {
      return { error: "missing-hiplot-or-pplot" };
    }
    const dims = Array.from(pplot.state.dimensions);
    if (dims.length < 2) {
      return { error: "not-enough-dimensions" };
    }
    const invertDim = dims[0];
    const filterDim = dims[1];
    const wasInverted = pplot.state.invert.has(invertDim);
    const expectedRangeAfterToggle = !wasInverted ? [0, pplot.h] : [pplot.h, 0];

    const invertExtent = pplot.toggleInvertAxis(invertDim);
    const rangeImmediatelyAfterToggle = pplot.yscale[invertDim].range().slice();
    pplot.update_ticks(invertDim, invertExtent);
    await sleep(150);
    const rangeAfterInvert = pplot.yscale[invertDim].range().slice();

    const brushEl = pplot.dimensions_dom
      .filter((d: string) => d === filterDim)
      .select(".pplot-brush");
    pplot.d3brush.move(brushEl, [60, Math.min(260, pplot.h - 20)]);
    await sleep(250);

    const selectedCount = hiplot.state.rows_selected.length;
    const filteredCount = hiplot.state.rows_filtered.length;
    if (!(selectedCount > 0 && selectedCount < filteredCount)) {
      return {
        error: `invalid-selection-size:${selectedCount}/${filteredCount}`,
        rangeAfterInvert,
      };
    }

    hiplot.filterRows(true);
    await sleep(250);
    hiplot.restoreAllRows();
    await sleep(300);
    const rangeAfterRestore = pplot.yscale[invertDim].range().slice();
    return {
      invertDim,
      filterDim,
      expectedRangeAfterToggle,
      rangeImmediatelyAfterToggle,
      rangeAfterInvert,
      rangeAfterRestore,
    };
  });
  expect(result.error).toBeUndefined();
  expect(result.rangeImmediatelyAfterToggle).toEqual(result.expectedRangeAfterToggle);
  expect(result.rangeAfterInvert).toEqual(result.expectedRangeAfterToggle);
  expect(result.rangeAfterRestore).toEqual(result.rangeAfterInvert);
});

test("inverting another axis does not temporarily unhide ticks on an actively filtered axis", async ({
  page,
}) => {
  await loadDemo(page);
  const result = await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const hiplot = (window as any).hiplot_last_instance;
    const pplot = hiplot?.plugins_ref?.PARALLEL_PLOT?.current;
    if (!hiplot || !pplot) {
      return { error: "missing-hiplot-or-pplot" };
    }
    const dims = Array.from(pplot.state.dimensions);
    if (dims.length < 2) {
      return { error: "not-enough-dimensions" };
    }
    const filteredDim = dims[0];
    const actionDim = dims[1];

    const brushEl = pplot.dimensions_dom
      .filter((d: string) => d === filteredDim)
      .select(".pplot-brush");
    pplot.d3brush.move(brushEl, [60, Math.min(260, pplot.h - 20)]);
    await sleep(250);

    const dimNode = pplot.dimensions_dom
      .filter((d: string) => d === filteredDim)
      .node() as SVGGElement;
    if (!dimNode) {
      return { error: "missing-filtered-dimension-node" };
    }

    const isAxisTick = (el: SVGTextElement) =>
      !el.classList.contains("pplot-label") && !el.classList.contains("label-name");
    const hiddenBefore = Array.from(dimNode.querySelectorAll("text")).filter((el) => {
      const textEl = el as SVGTextElement;
      return isAxisTick(textEl) && getComputedStyle(textEl).display === "none";
    }) as SVGTextElement[];
    if (hiddenBefore.length === 0) {
      return { error: "no-hidden-ticks-after-brush" };
    }

    let flashed = false;
    const watched = new Set(hiddenBefore);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target = mutation.target as SVGTextElement;
        if (watched.has(target) && getComputedStyle(target).display !== "none") {
          flashed = true;
          break;
        }
      }
    });
    observer.observe(dimNode, {
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    const invertExtent = pplot.toggleInvertAxis(actionDim);
    pplot.update_ticks(actionDim, invertExtent);
    await sleep(300);
    observer.disconnect();

    return {
      flashed,
      hiddenBeforeCount: hiddenBefore.length,
    };
  });
  expect(result.error).toBeUndefined();
  expect(result.hiddenBeforeCount).toBeGreaterThan(0);
  expect(result.flashed).toBe(false);
});

test("table keeps correct column-value mapping after column reorder and brush update", async ({
  page,
}) => {
  await loadDemo(page);
  const result = await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const hiplot = (window as any).hiplot_last_instance;
    const table = hiplot?.plugins_ref?.TABLE?.current;
    const pplot = hiplot?.plugins_ref?.PARALLEL_PLOT?.current;
    if (!hiplot || !table || !table.dt || !pplot) {
      return { error: "missing-hiplot-table-or-pplot" };
    }
    const dt = table.dt;
    const expMetricOriginalIdx = table.ordered_cols.indexOf("exp_metric");
    if (expMetricOriginalIdx < 0) {
      return { error: "missing-exp-metric-column" };
    }

    const currentOrder = dt.colReorder.order() as number[];
    const without = currentOrder.filter((idx) => idx !== expMetricOriginalIdx);
    // Keep color column first, move exp_metric as the second visible data column.
    without.splice(2, 0, expMetricOriginalIdx);
    dt.colReorder.order(without);

    const dims = Array.from(pplot.state.dimensions);
    if (dims.length === 0) {
      return { error: "no-parallel-dimensions" };
    }
    const brushDim = dims[0];
    const brushEl = pplot.dimensions_dom
      .filter((d: string) => d === brushDim)
      .select(".pplot-brush");
    pplot.d3brush.move(brushEl, [60, Math.min(260, pplot.h - 20)]);
    await sleep(300);

    const headers = Array.from(document.querySelectorAll("table.sample-rows-table thead th")).map(
      (th) => (th.textContent || "").trim(),
    );
    const expMetricVisibleIdx = headers.indexOf("exp_metric");
    if (expMetricVisibleIdx < 0) {
      return { error: "exp-metric-not-visible", headers };
    }

    const cells = Array.from(
      document.querySelectorAll(
        `table.sample-rows-table tbody tr td:nth-child(${expMetricVisibleIdx + 1})`,
      ),
    )
      .map((td) => (td.textContent || "").trim())
      .filter((v) => v.length > 0)
      .slice(0, 20);
    if (cells.length === 0) {
      return { error: "no-cells-read" };
    }
    const numericCount = cells.filter((v) => Number.isFinite(Number(v))).length;
    const uidLikeHexCount = cells.filter((v) => /^[a-f0-9]{6,}$/i.test(v)).length;
    return {
      cells,
      numericCount,
      uidLikeHexCount,
    };
  });

  expect(result.error).toBeUndefined();
  expect(result.numericCount).toBeGreaterThan(0);
  expect(result.uidLikeHexCount).toBe(0);
});

test("plotxy timestamp axis labels are not scientific notation", async ({ page }) => {
  await loadDemo(page);
  // The XY plot mounts once its container has been measured (debounced resize).
  await page.waitForFunction(() => (window as any).hiplot_last_instance?.plugins_ref?.XY?.current?.plot);
  const result = await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const hiplot = (window as any).hiplot_last_instance;
    const plotxy = hiplot?.plugins_ref?.XY?.current;
    if (!plotxy || !plotxy.plot) {
      return { error: "missing-plotxy" };
    }
    plotxy.setState({ axis_x: "timestamp" });
    await sleep(250);
    const axisGroups = Array.from(document.querySelectorAll("svg .axis_render"));
    const xAxis = axisGroups[0];
    if (!xAxis) {
      return { error: "missing-x-axis-group" };
    }
    const labels = Array.from(xAxis.querySelectorAll(".tick text")).map((el) =>
      (el.textContent || "").trim(),
    );
    const nonEmpty = labels.filter((l) => l.length > 0);
    if (nonEmpty.length === 0) {
      return { error: "no-tick-labels" };
    }
    const sciCount = nonEmpty.filter((l) => /e[+-]?\d+/i.test(l)).length;
    return { nonEmptyCount: nonEmpty.length, sciCount, labels: nonEmpty.slice(0, 12) };
  });
  expect(result.error).toBeUndefined();
  expect(result.nonEmptyCount).toBeGreaterThan(0);
  expect(result.sciCount).toBe(0);
});
