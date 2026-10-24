/**
 * Build-time prerender. For each page, the build calls prerender() and writes the result into a copy of
 * index.html, so search engines and social sites see real content and the right title, description and
 * metadata, with no script needed. The app pages (create, polls) get their metadata only, because they
 * are drawn in the browser.
 *
 * Set SITE_URL when building to use your own address in canonical links, the sitemap and share images.
 */
import { ALL_PAGES, headFor } from "../shared/routes";
import { PAGES } from "./src/pages/registry";
import { renderToString } from "./src/renderStatic";

// SITE_URL from the build's environment, handed in by vite.config.ts (the bundler rewrites process.env lookups).
declare const __SITE_URL__: string;
const siteUrlFromEnv = () => (typeof __SITE_URL__ === "string" && __SITE_URL__ ? __SITE_URL__ : undefined);

export async function prerender({ url }: { url: string }) {
  const path = url.replace(/\/+$/, "") || "/";
  const meta = ALL_PAGES.find((p) => p.path === path);
  if (!meta) return { html: "" };
  const page = PAGES.find((p) => p.path === path);
  return {
    html: page ? renderToString(<page.Component />) : "",
    head: headFor(meta, siteUrlFromEnv()),
  };
}

/** Every page the build should write, besides the home page. */
export const ROUTES = ALL_PAGES.map((p) => p.path).filter((p) => p !== "/");
