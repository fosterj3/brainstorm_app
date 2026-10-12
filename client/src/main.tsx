import { render } from "preact";
import { App } from "./App";
import { Facilitator } from "./Facilitator";
import "./styles.css";

const isFacilitator = location.pathname.replace(/\/+$/, "") === "/facilitator";
render(isFacilitator ? <Facilitator /> : <App />, document.getElementById("app")!);
