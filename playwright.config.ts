import { defineConfig } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env" });

// Invoked through real Node (see package.json), never `bunx`: Playwright's
// driver handshake does not complete under Bun's runtime and simply hangs.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
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
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
