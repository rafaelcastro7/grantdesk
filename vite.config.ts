import { defineConfig } from "@lovable.dev/lovite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { fileURLToPath, URL } from "node:url";

// Port 5180 is used locally. In Lovable sandbox, lovite automatically
// switches to host "::" and port 8080 when LOVABLE_SANDBOX=1.
// See: https://www.npmjs.com/package/@lovable.dev/lovite
export default defineConfig({
  plugins: [...tanstackStart({ server: { entry: "server" } }), react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
});
