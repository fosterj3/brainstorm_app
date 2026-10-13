import "@fontsource-variable/noto-sans";
import { render } from "preact";
import { Facilitator } from "./Facilitator";
import { Home } from "./Home";
import { Participant } from "./Participant";
import "./styles.css";

// Routes: / (home), /s/<code> (participants), /f/<code> (facilitator, secret key in the #fragment).
const [, area, code] = location.pathname.split("/");
const view =
  area === "s" && code ? <Participant sid={code} /> :
  area === "f" && code ? <Facilitator sid={code} /> :
  <Home />;

render(view, document.getElementById("app")!);
