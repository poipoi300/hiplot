import { chromium } from "@playwright/test";
import { withDeadline } from "../bench/deadline";
import { expect, test } from "./fixtures";

test("the whole-attempt deadline interrupts a CPU-bound initial browser evaluation", async () => {
  const server = await chromium.launchServer();
  const browser = await chromium.connect(server.wsEndpoint());
  const context = await browser.newContext();
  const page = await context.newPage();
  const started = performance.now();
  try {
    await expect(
      withDeadline(
        () =>
          page.evaluate(() => {
            const end = performance.now() + 10_000;
            while (performance.now() < end) {
              /* A renderer that cannot process browser timers. */
            }
          }),
        100,
        () => "Parallel benchmark, last stage: initial evaluation",
        () => server.kill(),
      ),
    ).rejects.toThrow("last stage: initial evaluation exceeded 100 ms");
    // Callers may clean up or start another attempt immediately after rejection.
    expect(page.isClosed()).toBe(true);
    await expect.poll(() => page.isClosed()).toBe(true);
    expect(performance.now() - started).toBeLessThan(5000);
  } finally {
    await browser.close();
    await server.close();
  }
});
