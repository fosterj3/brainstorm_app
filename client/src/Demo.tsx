import { render } from "preact";

/**
 * A visible notice for demo hosting, where polls can be erased when the service sleeps or restarts. The server turns
 * it on with DEMO_NOTICE=1 (see README, Hosting). It is a separate piece of the page, so it never affects how the
 * rest of the page loads.
 */
export function DemoNotice() {
  return (
    <div class="demo-notice" role="note">
      <strong>Demo site.</strong> Polls here can be erased when the service restarts or goes to sleep, so do not rely on a poll
      staying open for days. Download your results when a poll closes. <a href="/faq#kept">Why?</a>
    </div>
  );
}

/** Ask the server whether this is a demo, and show the notice at the top of the page if so. Fails quietly. */
export async function showDemoNoticeIfNeeded() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok || !((await res.json()) as { demo?: boolean }).demo) return;
    const host = document.createElement("div");
    host.id = "demo-notice-root";
    document.body.insertBefore(host, document.body.firstChild);
    render(<DemoNotice />, host);
  } catch {
    /* No notice if the server cannot be reached. The page itself works either way. */
  }
}
