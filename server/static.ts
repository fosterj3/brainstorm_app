import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { ALL_PAGES } from "../shared/routes";

/** Pages that have their own prerendered file, such as /templates -> templates/index.html. */
const PAGE_PATHS = new Set(ALL_PAGES.map((p) => p.path).filter((p) => p !== "/" && p !== "/404" && p !== "/app"));

export interface Resolved {
  /** The file to send, relative to the build folder. */
  file: string;
  status: number;
}

/**
 * Decide what to send for an address that is not a file on disk:
 * - a website page, such as /faq, gets its own prerendered HTML;
 * - a poll link (/s/<code> or /f/<code>) gets the bare app shell, which keeps itself out of search engines;
 * - anything else gets the friendly "page not found" page, with a real 404 status.
 */
export function resolvePage(pathname: string): Resolved {
  const clean = pathname.replace(/\/+$/, "") || "/";
  if (clean === "/") return { file: "index.html", status: 200 };
  if (PAGE_PATHS.has(clean)) return { file: `${clean.slice(1)}/index.html`, status: 200 };
  if (/^\/[sf]\/[^/]+$/.test(clean)) return { file: "app/index.html", status: 200 };
  return { file: "404/index.html", status: 404 };
}

/** Serve the built site from `dist`: static files, prerendered pages, the app shell and the 404 page. */
export async function registerStatic(app: FastifyInstance, dist: string) {
  await app.register(fastifyStatic, {
    root: dist,
    // Folders are not served as pages by the file server. The handler below decides what each address shows, so
    // that /404 (and anything else that is not a real page) can answer with a real 404 status.
    index: false,
    // Only addresses that name a file (like /favicon.svg or /assets/app.js) are served by the file server.
    allowedPath: (pathName) => /\.[a-z0-9]+$/i.test(pathName),
    // File names under /assets carry a hash of their content, so they can be kept forever. Pages must be checked each time.
    setHeaders(res, filePath) {
      const p = filePath.split(path.sep).join("/");
      if (p.includes("/assets/")) res.header("cache-control", "public, max-age=31536000, immutable");
      else if (p.endsWith(".html")) res.header("cache-control", "no-cache");
      else res.header("cache-control", "public, max-age=3600");
    },
  });

  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split("?")[0];
    const isPage = (req.method === "GET" || req.method === "HEAD") && !pathname.startsWith("/api") && !pathname.startsWith("/ws");
    if (!isPage) return reply.code(404).send({ error: "not_found", message: "Not found." });
    let { file, status } = resolvePage(pathname);
    // An older build without the prerendered pages still works: fall back to the one app page.
    if (!fs.existsSync(path.join(dist, file))) file = "index.html";
    return reply.code(status).type("text/html; charset=utf-8").header("cache-control", "no-cache").sendFile(file);
  });
}
