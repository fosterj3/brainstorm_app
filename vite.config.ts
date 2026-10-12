import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  root: "client",
  plugins: [preact()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000", "/ws": { target: "ws://localhost:3000", ws: true } } },
  test: { root: ".", include: ["server/**/*.test.ts", "client/**/*.test.ts"] },
});
