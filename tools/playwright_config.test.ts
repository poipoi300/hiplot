import { expect, test } from "bun:test";

test("CI keeps renderer cases within each file sequential", () => {
  const configUrl = new URL("../playwright.config.ts", import.meta.url).href;
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `const { default: config } = await import(${JSON.stringify(configUrl)});
       const browser = config.projects.find((project) => project.name === "browser");
       console.log(JSON.stringify(browser.fullyParallel ?? config.fullyParallel ?? false));`,
    ],
    env: { ...process.env, CI: "1" },
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toBe(false);
});
