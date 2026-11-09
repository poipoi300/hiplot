import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: "http://127.0.0.1:8765",
    // Without these, a machine with no usable GPU (CI runners, headless
    // shells) composites the page in software and reads every WebGL frame
    // back synchronously, so each input event waits for a whole frame: an
    // axis drag took 7.5 times as long. Compositing on SwiftShader, like
    // WebGL already is, removes the readback.
    launchOptions: {
      args: [
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--enable-gpu-rasterization",
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "bash scripts/ensure-bundle.sh && uv run --extra server hiplot --port 8765 --host 0.0.0.0",
    url: "http://127.0.0.1:8765",
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
