import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { measureFrameCadence } from "./environment.ts";
import type { profileHistogramUploads } from "./rust_gpu";
import type { profileRustKernels } from "./rust_kernels";

const { values } = parseArgs({
  options: {
    "baseline-js": { type: "string" },
    loads: { type: "string", default: "1" },
    repetitions: { type: "string", default: "9" },
    "uploads-only": { type: "boolean", default: false },
    out: { type: "string", default: "outputs/rust/kernels.json" },
  },
});
const loads = Number(values.loads);
const repetitions = Number(values.repetitions);
if (![loads, repetitions].every((value) => Number.isSafeInteger(value) && value > 0))
  throw new Error("Loads and repetitions must be positive integers");

const bundle = "node_modules/.cache/rust-kernels-bench.js";
const build = spawnSync(
  "bun",
  ["build", "bench/rust_kernels.ts", "--target=browser", "--format=iife", `--outfile=${bundle}`],
  { stdio: "inherit" },
);
if (build.error) throw build.error;
if (build.status !== 0) throw new Error(`Benchmark build failed (${build.status})`);
const source = readFileSync(bundle, "utf8");
const browser = await chromium.launch({ channel: "chromium", headless: true });
const version = browser.version();
const variants = [{ label: "candidate", source }];
if (values["baseline-js"] !== undefined)
  variants.unshift({ label: "baseline", source: readFileSync(values["baseline-js"], "utf8") });
const results: {
  label: string;
  load: number;
  cadence: Awaited<ReturnType<typeof measureFrameCadence>>;
  profiles: ReturnType<typeof profileRustKernels>[];
  uploads: ReturnType<typeof profileHistogramUploads> | null;
}[] = [];
try {
  for (let load = 0; load < loads; ++load) {
    for (const variant of load % 2 === 0 ? variants : [...variants].reverse()) {
      const context = await browser.newContext({
        viewport: { width: 1000, height: 700 },
        deviceScaleFactor: 1,
      });
      try {
        const page = await context.newPage();
        await page.addScriptTag({ content: variant.source });
        const cadence = await measureFrameCadence(page);
        const profiles = values["uploads-only"]
          ? []
          : await page.evaluate((repetitions) => {
              const profile = (
                window as unknown as {
                  rustBenchmark: { profileRustKernels: typeof profileRustKernels };
                }
              ).rustBenchmark.profileRustKernels;
              return [profile(50_000, repetitions), profile(1_000_000, repetitions)];
            }, repetitions);
        const uploads =
          variant.label === "candidate"
            ? await page.evaluate(() =>
                (
                  window as unknown as {
                    rustBenchmark: { profileHistogramUploads: typeof profileHistogramUploads };
                  }
                ).rustBenchmark.profileHistogramUploads(),
              )
            : null;
        results.push({ label: variant.label, load, cadence, profiles, uploads });
      } finally {
        await context.close();
      }
    }
  }
  const output = values.out;
  mkdirSync(path.dirname(output), { recursive: true });
  const report = {
    environment: {
      browser: version,
      platform: process.platform,
      arch: process.arch,
      viewport: { width: 1000, height: 700 },
    },
    results,
  };
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
