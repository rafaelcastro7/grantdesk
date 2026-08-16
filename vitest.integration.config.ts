import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";
import { config } from "dotenv";

// Integration tests talk to the live local stack, so they are a separate run
// from the hermetic unit suite: `bun run test` must stay fast and offline.
config({ path: ".env" });

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Shared database rows; parallel files would race on the same catalog.
    fileParallelism: false,
  },
});
