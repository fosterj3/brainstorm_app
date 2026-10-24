/**
 * A small renderer that turns the site's content pages into HTML text at build time, so every page is real HTML
 * with its own title and description before any script runs. It exists so the build needs no extra package.
 * (The usual choice is the `preact-render-to-string` package; swap it in here if you ever prefer it.)
 *
 * It covers what the content pages use: elements, text, fragments, lists of children and function components
 * without hooks. Event handlers, refs and keys are left out, because the page is hydrated in the browser.
 */
import type { ComponentChildren, VNode } from "preact";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ALIASES: Record<string, string> = { className: "class", htmlFor: "for", tabIndex: "tabindex", crossOrigin: "crossorigin", acceptCharset: "accept-charset" };

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

const kebab = (name: string) => (name.startsWith("--") ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
const styleText = (style: Record<string, string | number>) =>
  Object.entries(style)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${kebab(k)}:${v}`)
    .join(";");

function attributes(props: Record<string, unknown>): string {
  let out = "";
  for (const [name, value] of Object.entries(props)) {
    if (name === "children" || name === "key" || name === "ref" || name === "dangerouslySetInnerHTML") continue;
    if (/^on[A-Z]/.test(name) || typeof value === "function") continue;
    if (value === null || value === undefined || value === false) continue;
    const attr = ALIASES[name] ?? name;
    if (value === true) out += ` ${attr}`;
    else if (name === "style" && typeof value === "object") out += ` style="${escapeAttr(styleText(value as Record<string, string | number>))}"`;
    else out += ` ${attr}="${escapeAttr(String(value))}"`;
  }
  return out;
}

/** Render a tree of elements and components to an HTML string. */
export function renderToString(node: ComponentChildren): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string") return escapeText(node);
  if (typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) return node.map(renderToString).join("");

  const vnode = node as VNode<Record<string, unknown>>;
  const { type } = vnode;
  const props = (vnode.props ?? {}) as Record<string, unknown>;

  if (typeof type === "function") return renderToString((type as (p: unknown) => ComponentChildren)(props));
  if (typeof type !== "string") return "";

  const open = `<${type}${attributes(props)}>`;
  if (VOID.has(type)) return open;
  const raw = props.dangerouslySetInnerHTML as { __html?: string } | undefined;
  const inner = raw?.__html ?? renderToString(props.children as ComponentChildren);
  return `${open}${inner}</${type}>`;
}
