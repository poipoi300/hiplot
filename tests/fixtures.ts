import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";

const COVERAGE_DIR = path.resolve(".nyc_output");
const COLLECTING = process.env.HIPLOT_COVERAGE === "1";

/** Writes the istanbul counters of the document `page` shows, if it is instrumented. */
async function saveCoverage(page: Page): Promise<void> {
  const coverage: unknown = await page.evaluate(
    () => (window as unknown as { __coverage__?: unknown }).__coverage__ ?? null,
  );
  if (coverage !== null) {
    mkdirSync(COVERAGE_DIR, { recursive: true });
    writeFileSync(path.join(COVERAGE_DIR, `${randomUUID()}.json`), JSON.stringify(coverage));
  }
}

/**
 * The Playwright `test`, extended to save istanbul coverage when the bundle is
 * instrumented (see tools/e2e_coverage.sh): from every page a test opened when
 * it ends, and from a document before `reload` or `goto` replaces it, so what
 * a test exercised before reloading counts too.
 */
export const test = base.extend<{ saveCoverage: undefined }>({
  page: async ({ page }, use) => {
    if (COLLECTING) {
      const reload = page.reload.bind(page);
      const goto = page.goto.bind(page);
      page.reload = async (options) => {
        await saveCoverage(page);
        return reload(options);
      };
      page.goto = async (url, options) => {
        if (page.url() !== "about:blank") {
          await saveCoverage(page);
        }
        return goto(url, options);
      };
    }
    await use(page);
  },
  saveCoverage: [
    async ({ context }, use) => {
      await use(undefined);
      if (!COLLECTING) {
        return;
      }
      for (const page of context.pages()) {
        await saveCoverage(page);
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
