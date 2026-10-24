import { Fragment } from "preact";
import { describe, expect, it } from "vitest";
import { renderToString } from "./renderStatic";

const Greeting = ({ name, children }: { name: string; children?: preact.ComponentChildren }) => (
  <p class="greeting">Hello, {name}!{children}</p>
);

describe("renderToString", () => {
  it("renders elements, attributes and text", () => {
    expect(renderToString(<a class="x" href="/create?template=a&b=1">Go</a>)).toBe('<a class="x" href="/create?template=a&amp;b=1">Go</a>');
  });
  it("escapes text and attribute values", () => {
    expect(renderToString(<p title={'say "hi" <now>'}>{"1 < 2 & 3 > 2"}</p>)).toBe('<p title="say &quot;hi&quot; &lt;now&gt;">1 &lt; 2 &amp; 3 &gt; 2</p>');
  });
  it("handles void elements, boolean attributes, aliases and style objects", () => {
    expect(renderToString(<input type="checkbox" disabled checked={false} />)).toBe('<input type="checkbox" disabled>');
    expect(renderToString(<label htmlFor="a" className="b">x</label>)).toBe('<label for="a" class="b">x</label>');
    expect(renderToString(<div style={{ "--c": "red", backgroundColor: "blue", width: "50%" }} />)).toBe('<div style="--c:red;background-color:blue;width:50%"></div>');
    expect(renderToString(<details open><summary>More</summary></details>)).toBe("<details open><summary>More</summary></details>");
  });
  it("keeps aria and data attributes, and drops handlers, refs and keys", () => {
    expect(renderToString(<button aria-label="Close" data-x="1" onClick={() => {}} key="k">x</button>)).toBe('<button aria-label="Close" data-x="1">x</button>');
  });
  it("renders components, fragments, arrays and nested children", () => {
    const html = renderToString(
      <Fragment>
        <Greeting name="Ana"><b>!</b></Greeting>
        {["a", "b"].map((x) => <i key={x}>{x}</i>)}
        {null}{false}{undefined}{0}
      </Fragment>,
    );
    expect(html).toBe('<p class="greeting">Hello, Ana!<b>!</b></p><i>a</i><i>b</i>0');
  });
  it("renders raw HTML only where asked", () => {
    expect(renderToString(<div dangerouslySetInnerHTML={{ __html: "<b>ok</b>" }} />)).toBe("<div><b>ok</b></div>");
  });
});
