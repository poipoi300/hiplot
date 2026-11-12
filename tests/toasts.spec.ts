import type { Page } from "@playwright/test";
import type { HiPlot } from "../src/component";
import { Experiment } from "../src/types";
import { expect, test } from "./fixtures";

interface ToastWindow {
  hiplot_last_instance: HiPlot;
  copiedMessages: string[];
}

async function load(page: Page, error?: string): Promise<void> {
  const experiment = Experiment.from_iterable(
    Array.from({ length: 30 }, (_, index) => ({ score: index, loss: 30 - index })),
  );
  await page.route("**/data?uri=toast-test", (route) =>
    route.fulfill({ json: error === undefined ? { experiment } : { error } }),
  );
  await page.goto("/");
  const input = page.getByPlaceholder("Experiments to load");
  await input.fill("toast-test");
  await input.press("Enter");
}

test("load errors appear only as persistent, dismissible toasts", async ({ page }) => {
  await page.clock.install();
  await load(page, "Could not load checkpoint");
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("Could not load checkpoint");
  await expect(page.locator(".alert-danger")).toHaveCount(0);
  await page.clock.fastForward(60_000);
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(toast).toHaveCount(0);
});

test("a toast copies its full message without dismissing it", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as ToastWindow).copiedMessages = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) =>
          (window as unknown as ToastWindow).copiedMessages.push(text),
      },
    });
  });
  await load(page);
  const message =
    'Column "load_checkpoint": no finite numeric values; using a categorical scale instead.';
  await page.evaluate(
    (text) => (window as unknown as ToastWindow).hiplot_last_instance.notify(text),
    message,
  );
  const toast = page.getByTestId("toast");
  await toast.getByRole("button", { name: "Copy message" }).click();
  await expect(toast.getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => (window as unknown as ToastWindow).copiedMessages)).toEqual([
    message,
  ]);
  await expect(toast).toBeVisible();
});

test("rejected loads produce a toast without an unhandled error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/data?uri=toast-test", (route) => route.fulfill({ json: { invalid: true } }));
  await page.goto("/");
  await page.getByPlaceholder("Experiments to load").fill("toast-test");
  await page.getByPlaceholder("Experiments to load").press("Enter");
  await expect(page.getByTestId("toast")).toContainText(
    "The HiPlot server returned a malformed response",
  );
  await expect(page.locator(".alert-danger")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("clipboard failures leave the message available to copy manually", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("Clipboard denied");
        },
      },
    });
    document.execCommand = () => false;
  });
  await load(page, "The server is unavailable");
  const toast = page.getByTestId("toast");
  await toast.getByRole("button", { name: "Copy message" }).click();
  await expect(toast.getByRole("status")).toContainText("Select and copy the message");
  await expect(toast).toContainText("The server is unavailable");
  expect(errors).toEqual([]);
});

test("a display that repeatedly fails reports its error only in toasts", async ({ page }) => {
  await load(page);
  await expect(page.locator("svg g.dimension").first()).toBeAttached();
  await page.evaluate(() => {
    const instance = (window as unknown as ToastWindow).hiplot_last_instance;
    const plugin = instance.props.plugins.PARALLEL_PLOT;
    plugin.prototype.render = () => {
      throw new Error("The plot cannot render");
    };
    instance.parallelPlot()?.forceUpdate();
  });
  await expect(
    page.getByTestId("toast").filter({ hasText: "failed again and stays off" }),
  ).toContainText("The plot cannot render");
  await expect(page.locator(".alert-danger")).toHaveCount(0);
  await expect(page.locator("table tbody tr")).not.toHaveCount(0);
});

for (const { width, theme } of [
  { width: 320, theme: "Light" },
  { width: 1280, theme: "Dark" },
] as const) {
  test(`long toast stacks stay within a ${width}px ${theme.toLowerCase()} viewport and can be scrolled`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 600 });
    await load(page);
    await page.getByRole("button", { name: theme, exact: true }).click();
    await page.evaluate(() => {
      const instance = (window as unknown as ToastWindow).hiplot_last_instance;
      for (let index = 0; index < 12; index++) {
        instance.notify(
          `Column "checkpoint_${index}": the column has no finite numeric values; using a categorical scale instead. ${"A_long_checkpoint_name_".repeat(5)}`,
        );
      }
    });
    const toasts = page.getByTestId("toast");
    await expect(toasts).toHaveCount(12);
    await toasts.last().scrollIntoViewIfNeeded();
    const bounds = await toasts.last().boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    expect(
      await toasts
        .last()
        .locator("..")
        .evaluate((stack) => stack.scrollHeight > stack.clientHeight),
    ).toBe(true);
    await expect(toasts.last().getByRole("button", { name: "Copy message" })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`toasts-${width}-${theme.toLowerCase()}.png`),
    });
    await toasts.last().getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(toasts).toHaveCount(11);
  });
}
