import { FAQS } from "./faq.ts";
import { SITE, siteUrl } from "./site.ts";

/**
 * Every page on the site and what search engines and social sites should know about it. This is plain data so the
 * build (sitemap, robots), the prerender step and the tests all read the same list.
 *
 * A page title should stay under about 60 characters and a description under about 160.
 */
export interface PageMeta {
  path: string;
  title: string;
  description: string;
  /** Whether search engines should list it. Tool pages and the 404 page are kept out. */
  index: boolean;
  /** True for pages that are plain content, written in advance. The rest are the app. */
  content: boolean;
}

export const CONTENT_PAGES: PageMeta[] = [
  {
    path: "/",
    title: "Ority: get a group to agree on what matters most",
    description: "Create a poll in under a minute, share one link, and see what your group chooses. Dot voting, ranking, scoring and the 100 point method. No accounts needed.",
    index: true,
    content: true,
  },
  {
    path: "/templates",
    title: "Poll templates for teams and groups | Ority",
    description: "Start from a ready-made poll for team priorities, roadmap voting, survey follow-up, offsite ideas, ranking proposals or a quick group decision.",
    index: true,
    content: true,
  },
  {
    path: "/voting-methods",
    title: "Voting methods: dots, ranking, scoring, 100 points | Ority",
    description: "See how dot voting, rank order, scoring and the 100 point method work, how results are counted, and which one fits your decision.",
    index: true,
    content: true,
  },
  {
    path: "/faq",
    title: "FAQ: questions about Ority polls | Ority",
    description: "Answers about accounts, sharing, privacy, closing times, results and how long polls are kept.",
    index: true,
    content: true,
  },
  {
    path: "/privacy",
    title: "Privacy | Ority",
    description: "What Ority stores, who can see it, and how long it is kept, in plain language.",
    index: true,
    content: true,
  },
  {
    path: "/terms",
    title: "Terms of use | Ority",
    description: "The simple rules for using Ority.",
    index: true,
    content: true,
  },
  {
    path: "/404",
    title: "Page not found | Ority",
    description: "We could not find that page. Create a poll or head back to the start.",
    index: false,
    content: true,
  },
];

/** App pages: they have their own title and description, but no prerendered content. */
export const APP_PAGES: PageMeta[] = [
  { path: "/create", title: "Create a poll | Ority", description: "Create a poll, join one with a code, or find the polls you made on this device.", index: false, content: false },
  { path: "/app", title: "Ority", description: "A poll on Ority.", index: false, content: false },
];

export const ALL_PAGES: PageMeta[] = [...CONTENT_PAGES, ...APP_PAGES];

/** The pages that belong in the sitemap. */
export const SITEMAP_PATHS = CONTENT_PAGES.filter((p) => p.index).map((p) => p.path);

const absolute = (base: string, path: string) => (path === "/" ? `${base}/` : `${base}${path}`);

export interface HeadElement {
  type: string;
  props: Record<string, string>;
  children?: string;
}

/** JSON for a script tag, safe to place inside HTML. */
const jsonLd = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");

/** Everything that goes in a page's <head>, besides what the shared template already has. */
export function headFor(page: PageMeta, fromEnv?: string): { lang: string; title: string; elements: Set<HeadElement> } {
  const base = siteUrl(fromEnv);
  const url = absolute(base, page.path);
  const meta = (name: string, content: string): HeadElement => ({ type: "meta", props: { name, content } });
  const og = (property: string, content: string): HeadElement => ({ type: "meta", props: { property, content } });
  const elements: HeadElement[] = [
    meta("description", page.description),
    meta("robots", page.index ? "index, follow" : "noindex, follow"),
    og("og:type", "website"),
    og("og:site_name", SITE.name),
    og("og:title", page.title),
    og("og:description", page.description),
    og("og:image", `${base}/og-image.png`),
    og("og:image:alt", `${SITE.name}: ${SITE.tagline}`),
    meta("twitter:card", "summary_large_image"),
    meta("twitter:title", page.title),
    meta("twitter:description", page.description),
    meta("twitter:image", `${base}/og-image.png`),
  ];
  if (page.index) {
    elements.push({ type: "link", props: { rel: "canonical", href: url } }, og("og:url", url));
  }
  if (page.path === "/") {
    elements.push({
      type: "script",
      props: { type: "application/ld+json" },
      children: jsonLd({ "@context": "https://schema.org", "@type": "WebSite", name: SITE.name, url: `${base}/`, description: page.description }),
    });
  }
  if (page.path === "/faq") {
    elements.push({
      type: "script",
      props: { type: "application/ld+json" },
      children: jsonLd({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: FAQS.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
      }),
    });
  }
  return { lang: "en", title: page.title, elements: new Set(elements) };
}

/** The sitemap: only the pages worth listing. */
export function sitemapXml(fromEnv?: string): string {
  const base = siteUrl(fromEnv);
  const urls = SITEMAP_PATHS.map((p) => `  <url><loc>${absolute(base, p)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** robots.txt: let search engines in, but keep them out of private polls, organizer screens and the API. */
export function robotsTxt(fromEnv?: string): string {
  const base = siteUrl(fromEnv);
  return ["User-agent: *", "Allow: /", "Disallow: /s/", "Disallow: /f/", "Disallow: /api/", "Disallow: /ws", "", `Sitemap: ${base}/sitemap.xml`, ""].join("\n");
}
