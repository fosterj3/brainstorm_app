import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerStatic, resolvePage } from "./static";

describe("resolvePage", () => {
  it("sends website pages to their own prerendered file", () => {
    for (const p of ["/templates", "/voting-methods", "/faq", "/privacy", "/terms", "/create"]) {
      expect(resolvePage(p)).toEqual({ file: `${p.slice(1)}/index.html`, status: 200 });
      expect(resolvePage(`${p}/`)).toEqual({ file: `${p.slice(1)}/index.html`, status: 200 });
    }
    expect(resolvePage("/")).toEqual({ file: "index.html", status: 200 });
  });
  it("sends poll links to the bare app page", () => {
    expect(resolvePage("/s/abcd1234")).toEqual({ file: "app/index.html", status: 200 });
    expect(resolvePage("/f/abcd1234/")).toEqual({ file: "app/index.html", status: 200 });
  });
  it("answers anything else with the 404 page and a 404 status", () => {
    for (const p of ["/nope", "/s", "/s/", "/s/a/b", "/f", "/templates/x", "/404", "/app", "/apps"]) {
      expect(resolvePage(p)).toEqual({ file: "404/index.html", status: 404 });
    }
  });
});

describe("serving the built site", () => {
  let dir: string;
  let app: ReturnType<typeof Fastify>;

  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const boot = async () => {
    app = Fastify();
    await registerStatic(app, dir);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ority-dist-"));
    for (const [rel, marker] of [["index.html", "LANDING"], ["templates/index.html", "TEMPLATES"], ["faq/index.html", "FAQ"], ["create/index.html", "CREATE"], ["app/index.html", "APPSHELL"], ["404/index.html", "NOTFOUND"]]) {
      write(rel, `<!doctype html><title>${marker}</title><body>${marker}</body>`);
    }
    write("assets/app-abc123.js", "console.log(1)");
    write("favicon.svg", "<svg/>");
    write("sitemap.xml", "<urlset/>");
  });
  afterEach(async () => {
    await app?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves each website page with its own HTML, with or without a trailing slash", async () => {
    await boot();
    for (const [url, marker] of [["/", "LANDING"], ["/templates", "TEMPLATES"], ["/templates/", "TEMPLATES"], ["/faq", "FAQ"], ["/create", "CREATE"]]) {
      const res = await app.inject({ url });
      expect([url, res.statusCode, res.headers["content-type"]?.toString().startsWith("text/html")]).toEqual([url, 200, true]);
      expect(res.body).toContain(marker);
    }
  });
  it("serves the app page for poll links", async () => {
    await boot();
    for (const url of ["/s/abcd1234", "/f/abcd1234"]) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("APPSHELL");
    }
  });
  it("returns a real 404 with the friendly page for addresses that do not exist", async () => {
    await boot();
    for (const url of ["/nope", "/s", "/s/a/b", "/404", "/templates/extra"]) {
      const res = await app.inject({ url });
      expect([url, res.statusCode]).toEqual([url, 404]);
      expect(res.headers["content-type"]?.toString()).toContain("text/html");
      expect(res.body).toContain("NOTFOUND");
    }
  });
  it("keeps the API and sockets answering in JSON, and only serves pages for GET and HEAD", async () => {
    await boot();
    const api = await app.inject({ url: "/api/nothing" });
    expect([api.statusCode, api.json().error]).toEqual([404, "not_found"]);
    const post = await app.inject({ method: "POST", url: "/faq" });
    expect([post.statusCode, post.json().error]).toEqual([404, "not_found"]);
    expect((await app.inject({ method: "HEAD", url: "/faq" })).statusCode).toBe(200);
  });
  it("serves files with sensible caching: forever for hashed assets, always check for pages", async () => {
    await boot();
    expect((await app.inject({ url: "/assets/app-abc123.js" })).headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await app.inject({ url: "/templates" })).headers["cache-control"]).toBe("no-cache");
    expect((await app.inject({ url: "/index.html" })).headers["cache-control"]).toBe("no-cache");
    expect((await app.inject({ url: "/favicon.svg" })).headers["cache-control"]).toBe("public, max-age=3600");
    expect((await app.inject({ url: "/sitemap.xml" })).statusCode).toBe(200);
  });
  it("still works with an older build that has no prerendered pages", async () => {
    fs.rmSync(path.join(dir, "templates"), { recursive: true });
    fs.rmSync(path.join(dir, "404"), { recursive: true });
    await boot();
    const page = await app.inject({ url: "/templates" });
    expect([page.statusCode, page.body.includes("LANDING")]).toEqual([200, true]);
    const missing = await app.inject({ url: "/nope" });
    expect([missing.statusCode, missing.body.includes("LANDING")]).toEqual([404, true]);
  });
});
