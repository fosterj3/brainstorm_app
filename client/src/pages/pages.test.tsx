import { describe, expect, it } from "vitest";
import { FAQS, LANDING_FAQ_IDS } from "../../../shared/faq";
import { ALL_PAGES, APP_PAGES, CONTENT_PAGES, headFor, robotsTxt, SITEMAP_PATHS, sitemapXml } from "../../../shared/routes";
import { SITE } from "../../../shared/site";
import { TEMPLATES, templateById } from "../../../shared/templates";
import { resolvePage } from "../../../server/static";
import { prerender } from "../../prerender";
import { METHODS } from "../methods";

const html = async (path: string) => (await prerender({ url: path })).html as string;
const KNOWN = new Set(ALL_PAGES.map((p) => p.path));
const idsOf = (page: string) => [...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const linksOf = (page: string) => [...page.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1].replace(/&amp;/g, "&"), text: m[2].replace(/<[^>]+>/g, "").trim() }));
const textOf = (page: string) => page.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe.each(CONTENT_PAGES)("content page $path", (meta) => {
  it("has one h1 and headings that never skip a level", async () => {
    const page = await html(meta.path);
    expect((page.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    const levels = [...page.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    levels.forEach((level, i) => {
      if (i > 0) expect(level).toBeLessThanOrEqual(levels[i - 1] + 1);
    });
  });

  it("has the shared header, main area and footer, with a skip link first", async () => {
    const page = await html(meta.path);
    expect(page.startsWith('<a class="skip-link" href="#main">')).toBe(true);
    expect(page).toContain('<nav aria-label="Main">');
    expect(page).toContain('<main id="main"');
    expect(page).toContain("<footer");
    expect(page).toContain('<nav aria-label="Footer">');
    expect((page.match(/<main\b/g) ?? []).length).toBe(1);
  });

  it("has no broken output, no em dashes, unique ids, and alt text on any image", async () => {
    const page = await html(meta.path);
    const text = textOf(page);
    for (const bad of ["undefined", "[object", "NaN", "—"]) expect(text).not.toContain(bad);
    const ids = idsOf(page);
    expect(new Set(ids).size).toBe(ids.length);
    for (const img of page.match(/<img\b[^>]*>/g) ?? []) expect(img).toMatch(/\salt="/);
  });

  it("only links to pages that exist, with readable link text", async () => {
    const page = await html(meta.path);
    const ids = new Set(idsOf(page));
    for (const { href, text } of linksOf(page)) {
      expect(text.length, `link ${href} needs text`).toBeGreaterThan(0);
      expect(href, "no links off the site").not.toMatch(/^https?:/);
      const url = new URL(href, "http://x");
      if (href.startsWith("#")) {
        expect(ids.has(href.slice(1)), `${href} should point at an id on this page`).toBe(true);
        continue;
      }
      expect(KNOWN.has(url.pathname) || url.pathname === "/create", `${href} is a real page`).toBe(true);
      expect(resolvePage(url.pathname).status, `${href} is served`).toBe(200);
      const template = url.searchParams.get("template");
      if (template) expect(templateById(template), `${href} names a real template`).toBeTruthy();
      const method = url.searchParams.get("method");
      if (method) expect(METHODS.some((m) => m.id === method), `${href} names a real method`).toBe(true);
    }
  });

  it("marks the page you are on in the navigation", async () => {
    const page = await html(meta.path);
    if (["/templates", "/voting-methods", "/faq"].includes(meta.path)) { // the pages that have an item in the navigation
      expect(page).toContain(`href="${meta.path}" aria-current="page"`);
    }
  });
});

describe("titles, descriptions and share tags", () => {
  it("are present, the right length and different on every page", () => {
    const titles = ALL_PAGES.map((p) => p.title);
    const descriptions = ALL_PAGES.map((p) => p.description);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    for (const p of ALL_PAGES) {
      expect(p.title.length, p.path).toBeGreaterThan(3);
      expect(p.title.length, `${p.path} title`).toBeLessThanOrEqual(60);
      expect(p.description.length, `${p.path} description`).toBeGreaterThanOrEqual(12);
      expect(p.description.length, `${p.path} description`).toBeLessThanOrEqual(160);
      expect(p.title + p.description, p.path).not.toContain("—");
    }
  });

  it("go into each page's head, with an absolute address on the site's own domain", () => {
    for (const p of CONTENT_PAGES.filter((c) => c.index)) {
      const head = headFor(p, "https://example.org/");
      expect(head.title).toBe(p.title);
      const els = [...head.elements];
      const content = (name: string) => els.find((e) => e.props.name === name || e.props.property === name)?.props.content;
      expect(content("description")).toBe(p.description);
      expect(content("robots")).toBe("index, follow");
      expect(content("og:title")).toBe(p.title);
      expect(content("og:image")).toBe("https://example.org/og-image.png");
      expect(content("twitter:card")).toBe("summary_large_image");
      const canonical = els.find((e) => e.props.rel === "canonical")!.props.href;
      expect(canonical).toBe(p.path === "/" ? "https://example.org/" : `https://example.org${p.path}`);
    }
  });

  it("keep tool pages, private polls and the 404 page out of search engines", () => {
    for (const p of [...APP_PAGES, CONTENT_PAGES.find((c) => c.path === "/404")!]) {
      const head = headFor(p);
      expect([...head.elements].find((e) => e.props.name === "robots")!.props.content, p.path).toBe("noindex, follow");
      expect([...head.elements].some((e) => e.props.rel === "canonical"), p.path).toBe(false);
    }
  });

  it("add structured data for the home page and the FAQ", () => {
    const script = (path: string) => {
      const meta = ALL_PAGES.find((p) => p.path === path)!;
      const el = [...headFor(meta).elements].find((e) => e.type === "script");
      return el ? { raw: el.children!, data: JSON.parse(el.children!) } : null;
    };
    expect(script("/")!.data).toMatchObject({ "@type": "WebSite", name: "Ority" });
    const faq = script("/faq")!;
    expect(faq.data["@type"]).toBe("FAQPage");
    expect(faq.data.mainEntity).toHaveLength(FAQS.length);
    expect(faq.data.mainEntity[0]).toMatchObject({ "@type": "Question", name: FAQS[0].q, acceptedAnswer: { text: FAQS[0].a } });
    expect(faq.raw).not.toContain("<");
    expect(script("/privacy")).toBeNull();
  });
});

describe("prerender()", () => {
  it("returns content and head for content pages, and head only for app pages", async () => {
    for (const p of CONTENT_PAGES) {
      const r = await prerender({ url: p.path });
      expect(r.html.length, p.path).toBeGreaterThan(200);
      expect(r.head?.title).toBe(p.title);
    }
    for (const p of APP_PAGES) {
      const r = await prerender({ url: p.path });
      expect(r.html).toBe("");
      expect(r.head?.title).toBe(p.title);
    }
    expect(await prerender({ url: "/does-not-exist" })).toEqual({ html: "" });
    expect((await prerender({ url: "/faq/" })).head?.title).toBe(CONTENT_PAGES.find((p) => p.path === "/faq")!.title);
  });
});

describe("sitemap and robots.txt", () => {
  it("list only the public content pages, on the right domain", () => {
    expect(SITEMAP_PATHS).toEqual(["/", "/templates", "/voting-methods", "/faq", "/privacy", "/terms"]);
    const xml = sitemapXml("https://example.org");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(["https://example.org/", "https://example.org/templates", "https://example.org/voting-methods", "https://example.org/faq", "https://example.org/privacy", "https://example.org/terms"]);
    for (const hidden of ["/create", "/404", "/app", "/s/", "/f/"]) expect(xml).not.toContain(`example.org${hidden}`);
  });
  it("fall back to the default address, and ignore a SITE_URL that is not a web address", () => {
    expect(sitemapXml(undefined)).toContain(SITE.defaultUrl);
    expect(sitemapXml("not a url")).toContain(SITE.defaultUrl);
  });
  it("keep search engines out of private polls, organizer screens and the API", () => {
    const robots = robotsTxt("https://example.org");
    for (const rule of ["User-agent: *", "Allow: /", "Disallow: /s/", "Disallow: /f/", "Disallow: /api/", "Sitemap: https://example.org/sitemap.xml"]) expect(robots).toContain(rule);
  });
});

describe("what each page says", () => {
  it("landing: the tagline, one main call to action, 3 steps, every template, sample results, questions and a closing call", async () => {
    const page = await html("/");
    expect(page).toContain("Get a group to agree on what matters most");
    const links = linksOf(page);
    expect(links.filter((l) => l.href === "/create" && l.text === "Create a poll").length).toBeGreaterThanOrEqual(3); // header, hero, closing
    expect((page.match(/class="panel step-card"/g) ?? []).length).toBe(3);
    for (const t of TEMPLATES) expect(links.some((l) => l.href === `/create?template=${t.id}` && l.text.includes(t.name))).toBe(true);
    expect(page).toContain("Example results");
    expect(page).toContain('class="result-row top"');
    expect(page).toContain("Tied");
    expect((page.match(/<details class="faq"/g) ?? []).length).toBe(LANDING_FAQ_IDS.length);
    expect(page).toContain("Ready to get your group to agree?");
  });
  it("templates: a card for every template with a link to start from it", async () => {
    const page = await html("/templates");
    expect((page.match(/class="panel template-card"/g) ?? []).length).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) {
      expect(page).toContain(`id="${t.id}"`);
      expect(linksOf(page).some((l) => l.href === `/create?template=${t.id}` && l.text === "Use this template")).toBe(true);
    }
  });
  it("voting methods: all four explained, with a table that screen readers can read", async () => {
    const page = await html("/voting-methods");
    for (const m of METHODS) {
      expect(page).toContain(`id="${m.id}"`);
      expect(page).toContain(m.blurb);
      expect(linksOf(page).some((l) => l.href === `/create?method=${m.id}`)).toBe(true);
    }
    expect(page).toContain("<caption");
    expect((page.match(/<th scope="col">/g) ?? []).length).toBe(4);
    expect((page.match(/<th scope="row">/g) ?? []).length).toBe(4);
    expect(page).toContain("1, 2, 2, 4");
  });
  it("faq: every question and answer", async () => {
    const page = await html("/faq");
    for (const f of FAQS) {
      expect(page).toContain(`id="${f.id}"`);
      expect(textOf(page)).toContain(f.a.slice(0, 40));
    }
    expect((page.match(/<details[^>]*class="faq"/g) ?? []).length).toBe(FAQS.length);
  });
  it("privacy and terms: a visible draft notice and placeholders to fill in", async () => {
    for (const path of ["/privacy", "/terms"]) {
      const page = await html(path);
      expect(page).toContain("plain-language draft");
      expect(page).toContain(SITE.contactEmail);
      expect(page).toContain(SITE.organization);
    }
  });
  it("404: friendly, with ways back", async () => {
    const page = await html("/404");
    expect(page).toContain("We could not find that page");
    const hrefs = linksOf(page).map((l) => l.href);
    for (const h of ["/create", "/", "/templates", "/faq"]) expect(hrefs).toContain(h);
  });
});

describe("answers match what the product does", () => {
  it("the participant limit in the FAQ is the real limit", async () => {
    const { MAX_PARTICIPANTS } = await import("../../../server/votes");
    expect(FAQS.find((f) => f.id === "size")!.a).toContain(String(MAX_PARTICIPANTS));
  });
  it("the 90 day clean-up in the FAQ and privacy page matches the server", async () => {
    const index = await import("node:fs").then((fs) => fs.readFileSync(new URL("../../../server/index.ts", import.meta.url), "utf8"));
    expect(index).toMatch(/IDLE_MS = 90 \* 24/);
    expect(FAQS.find((f) => f.id === "kept")!.a).toContain("90 days");
    expect(await html("/privacy")).toContain("90 days");
  });
  it("the template list on the pages is the template list the create screen uses", () => {
    expect(TEMPLATES.map((t) => t.name)).toHaveLength(6);
  });
});
