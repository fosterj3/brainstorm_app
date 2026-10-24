import type { FunctionComponent } from "preact";
import { CONTENT_PAGES, type PageMeta } from "../../../shared/routes";
import { FaqPage, MethodsPage, TemplatesPage } from "./Content";
import { Landing } from "./Landing";
import { NotFoundPage, PrivacyPage, TermsPage } from "./Legal";

/** Which component draws each content page. The titles and descriptions live in shared/routes.ts. */
const COMPONENTS: Record<string, FunctionComponent> = {
  "/": Landing,
  "/templates": TemplatesPage,
  "/voting-methods": MethodsPage,
  "/faq": FaqPage,
  "/privacy": PrivacyPage,
  "/terms": TermsPage,
  "/404": NotFoundPage,
};

export interface ContentPage extends PageMeta {
  Component: FunctionComponent;
}

export const PAGES: ContentPage[] = CONTENT_PAGES.map((p) => ({ ...p, Component: COMPONENTS[p.path] }));

/** The page for a path (trailing slashes ignored), or undefined if it is not a content page. */
export const pageFor = (pathname: string): ContentPage | undefined => {
  const path = pathname.replace(/\/+$/, "") || "/";
  return PAGES.find((p) => p.path === path && p.path !== "/404");
};

export const NOT_FOUND = PAGES.find((p) => p.path === "/404")!;
