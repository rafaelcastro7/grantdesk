import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

// Hermetic unit suite: no network, no database, no Start plugin. If a test
// needs the live stack it belongs in tests/integration instead, so that
// `bun run verify` stays runnable on a machine with nothing else started.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.{ts,tsx}"],
  },
});
