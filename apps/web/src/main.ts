import { mount } from "svelte";

import "./ui-theme.css";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("Application mounting element is absent");

// Compile-time opt-in. The normal application cannot select a mock adapter
// by URL or by changing local browser state.
if (
  import.meta.env.MODE === "ui-fixture" &&
  ["/demo", "/demo/"].includes(window.location.pathname)
) {
  void import("./LegacyFixture.svelte").then(({ default: Fixture }) => {
    mount(Fixture, { target });
  });
} else {
  mount(App, { target });
}
