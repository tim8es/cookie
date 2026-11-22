import { mount } from "svelte";

import "./ui-theme.css";
import App from "./App.svelte";
import { isReservedPublicBookingPath } from "./lib/navigation";

const target = document.getElementById("app");
if (!target) throw new Error("Application mounting element is absent");

// Legacy fixture remains compile-time-only at /demo (separate from public booking).
// Never mount the owner or customer auth shell on a prospective salon link.
// Until public slug resolution and booking proofs are implemented, fail closed.
if (isReservedPublicBookingPath(window.location.pathname)) {
  void import("./PublicBookingUnavailable.svelte").then(
    ({ default: Unavailable }) => {
      mount(Unavailable, { target });
    },
  );
} else if (
  import.meta.env.MODE === "ui-fixture" &&
  ["/demo", "/demo/"].includes(window.location.pathname)
) {
  void import("./LegacyFixture.svelte").then(({ default: Fixture }) => {
    mount(Fixture, { target });
  });
} else {
  mount(App, { target });
}
