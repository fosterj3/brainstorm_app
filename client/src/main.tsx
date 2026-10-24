import "@fontsource-variable/noto-sans";
import { hydrate, render } from "preact";
import { showDemoNoticeIfNeeded } from "./Demo";
import { Facilitator } from "./Facilitator";
import { Home } from "./Home";
import { Participant } from "./Participant";
import { NOT_FOUND, pageFor } from "./pages/registry";
import "./styles.css";

// Routes:
//   /                         landing page (content, prerendered at build time)
//   /templates, /voting-methods, /faq, /privacy, /terms   content pages (prerendered)
//   /create                   create a poll, join one, find your polls
//   /s/<code>                 participants
//   /f/<code>                 organizer (secret key in the #fragment)
//   anything else             the "page not found" page
const path = location.pathname.replace(/\/+$/, "") || "/";
const parts = path.split("/"); // ["", "s", "<code>"]
const content = pageFor(path);

let view;
let prerendered = false; // content pages arrive as ready-made HTML, so the browser attaches to it instead of redrawing
if (parts[1] === "s" && parts[2] && parts.length === 3) view = <Participant sid={parts[2]} />;
else if (parts[1] === "f" && parts[2] && parts.length === 3) view = <Facilitator sid={parts[2]} />;
else if (path === "/create") view = <Home />;
else {
  const Page = (content ?? NOT_FOUND).Component;
  view = <Page />;
  prerendered = true;
}

const root = document.getElementById("app")!;
if (prerendered && root.hasChildNodes()) hydrate(view, root);
else render(view, root);
void showDemoNoticeIfNeeded();
