import { mount } from "svelte";

import "./ui-theme.css";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("Application mounting element is absent");

mount(App, { target });
