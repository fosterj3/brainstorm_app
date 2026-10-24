import path from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig, type Plugin } from "vitest/config";
import { ALL_PAGES, robotsTxt, sitemapXml } from "./shared/routes.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Writes sitemap.xml and robots.txt at build time, using SITE_URL (or the default address in shared/site.ts)
 * so the links match wherever the site is hosted.
 */
function seoFiles(): Plugin {
  return {
    name: "ority-seo-files",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemapXml(process.env.SITE_URL) });
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robotsTxt(process.env.SITE_URL) });
    },
  };
}

export default defineConfig({
  root: "client",
  // The site address from the build's environment, for canonical links and share images (see client/prerender.tsx).
  define: { __SITE_URL__: JSON.stringify(process.env.SITE_URL ?? "") },
  plugins: [
    preact({
      // Every content page becomes real HTML at build time (dist/templates/index.html and so on), with its own
      // title, description and share tags. See client/prerender.tsx.
      prerender: {
        enabled: true,
        renderTarget: "#app",
        prerenderScript: here("./client/prerender.tsx"),
        additionalPrerenderRoutes: ALL_PAGES.map((p) => p.path).filter((p) => p !== "/"),
      },
    }),
    seoFiles(),
  ],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000", "/ws": { target: "ws://localhost:3000", ws: true } } },
  test: { root: ".", include: ["server/**/*.test.{ts,tsx}", "client/**/*.test.{ts,tsx}", "shared/**/*.test.{ts,tsx}"] },
});
