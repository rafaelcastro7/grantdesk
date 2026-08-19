import { defineConfig } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env" });

// Invoked through real Node (see package.json), never `bunx`: Playwright's
// driver handshake does not complete under Bun's runtime and simply hangs.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5180",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: "bun run dev",
    url: "http://localhost:5180",
    // Never reuse a server this run did not start. A dev server left running
    // from an earlier session answered "every provider failed" for a request
    // that works perfectly against a fresh one, and the suite spent a full run
    // reporting a defect that did not exist — worse than being slow to start.
    // If a dev server is already up, Playwright says so plainly, and a clear
    // instruction beats a phantom failure.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
