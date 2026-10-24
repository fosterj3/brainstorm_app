import { describe, expect, it } from "vitest";
import { resolvePage } from "../../server/static";
import { DemoNotice } from "./Demo";
import { renderToString } from "./renderStatic";

describe("DemoNotice", () => {
  const html = renderToString(<DemoNotice />);
  it("says plainly that polls can be erased, and what to do about it", () => {
    expect(html).toContain("Demo site.");
    expect(html).toContain("can be erased");
    expect(html).toContain("Download your results");
    expect(html).toContain('role="note"');
  });
  it("links to the FAQ answer about how long polls are kept, and uses no em dashes", () => {
    expect(html).toContain('href="/faq#kept"');
    expect(resolvePage("/faq").status).toBe(200);
    expect(html).not.toContain("—");
  });
});
