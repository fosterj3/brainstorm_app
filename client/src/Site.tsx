import type { ComponentChildren } from "preact";
import { SITE } from "../../shared/site";

/** Text wordmark. A small amber dot (drawn in CSS) is the only decoration. */
export function Wordmark({ href = "/" }: { href?: string }) {
  return <a class="wordmark" href={href} aria-label="Ority home">Ority</a>;
}

export const TAGLINE = SITE.tagline;

const NAV = [
  { href: "/templates", label: "Templates" },
  { href: "/voting-methods", label: "Voting methods" },
  { href: "/faq", label: "FAQ" },
];

/**
 * Slim brand-colored navigation band, shared by every website page. `current` marks the page you are on, for people
 * using screen readers and for the highlight. Written without hooks so it can be prerendered.
 */
export function SiteHeader({ current }: { current?: string }) {
  return (
    <>
      <a class="skip-link" href="#main">Skip to main content</a>
      <header class="site-header">
        <div class="site-inner">
          <Wordmark />
          <nav aria-label="Main">
            <ul class="site-nav">
              {NAV.map((n) => (
                <li key={n.href}><a href={n.href} aria-current={current === n.href ? "page" : undefined}>{n.label}</a></li>
              ))}
              <li><a class="button-link light" href="/create" aria-current={current === "/create" ? "page" : undefined}>Create a poll</a></li>
            </ul>
          </nav>
        </div>
      </header>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer class="site-footer">
      <div class="site-inner footer-grid">
        <div>
          <span class="wordmark">Ority</span>
          <p class="site-tagline">{TAGLINE}</p>
        </div>
        <nav aria-label="Footer">
          <div class="footer-cols">
            <div>
              <h2 class="footer-h">Product</h2>
              <ul>
                <li><a href="/create">Create a poll</a></li>
                <li><a href="/templates">Templates</a></li>
                <li><a href="/voting-methods">Voting methods</a></li>
              </ul>
            </div>
            <div>
              <h2 class="footer-h">Help</h2>
              <ul>
                <li><a href="/faq">FAQ</a></li>
                <li><a href="/create#join">Join a poll</a></li>
              </ul>
            </div>
            <div>
              <h2 class="footer-h">Legal</h2>
              <ul>
                <li><a href="/privacy">Privacy</a></li>
                <li><a href="/terms">Terms of use</a></li>
              </ul>
            </div>
          </div>
        </nav>
      </div>
    </footer>
  );
}

/** The frame around every website page: header, a main area, footer. */
export function PageShell({ current, wide, children }: { current?: string; wide?: boolean; children: ComponentChildren }) {
  return (
    <>
      <SiteHeader current={current} />
      <main id="main" class={`page site-page${wide ? " wide-site" : ""}`}>{children}</main>
      <SiteFooter />
    </>
  );
}

/** A spinner with words, for screens that are waiting on the server. */
export function Loading({ label }: { label: string }) {
  return (
    <div class="loading" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
