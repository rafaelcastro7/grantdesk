import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { fileURLToPath, URL } from "node:url";

// Port 5180 keeps this stack fully separate from the predecessor on :8080, so
// both can run at once (see ADR-0001). Unit tests live in vitest.config.ts
// rather than here: the Start plugin rewrites server entrypoints, which a
// hermetic unit run has no business loading.
export default defineConfig({
  plugins: [...tanstackStart({ server: { entry: "server" } }), react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
});
