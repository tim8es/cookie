import { mount } from "svelte";
import "../ui-theme.css";
import Catalog from "./Catalog.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("UI kit mounting element is absent");

mount(Catalog, { target });
