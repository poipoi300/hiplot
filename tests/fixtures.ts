import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";

const COVERAGE_DIR = path.resolve(".nyc_output");

/**
 * The Playwright `test`, extended to save istanbul coverage from every page a
 * test opened when the bundle is instrumented (see tools/e2e_coverage.sh).
 */
export const test = base.extend<{ saveCoverage: undefined }>({
  saveCoverage: [
    async ({ context }, use) => {
      await use(undefined);
      if (process.env.HIPLOT_COVERAGE !== "1") {
        return;
      }
      mkdirSync(COVERAGE_DIR, { recursive: true });
      for (const page of context.pages()) {
        const coverage: unknown = await page.evaluate(
          () => (window as unknown as { __coverage__?: unknown }).__coverage__ ?? null,
        );
        if (coverage !== null) {
          writeFileSync(path.join(COVERAGE_DIR, `${randomUUID()}.json`), JSON.stringify(coverage));
        }
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
