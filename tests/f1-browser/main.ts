// Test-only Vite entrypoint, never imported from the shipping web application.
// Resolve Svelte runtime from the existing @cookie/web workspace dependency.
import { mount } from "../../apps/web/node_modules/svelte/src/index-client.js";
import "../../apps/web/src/ui-theme.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/visual-system.css";
import Fixture from "./BookingFixture.svelte";

const target = document.querySelector("#app");
if (!target) throw new Error("Synthetic browser fixture root is missing");
mount(Fixture, { target });
