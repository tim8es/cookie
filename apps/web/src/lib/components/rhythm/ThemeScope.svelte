<script lang="ts">
  import { setContext, type Snippet } from "svelte";
  import type { RhythmPreviewTheme } from "./contracts.js";
  import "./rhythm.css";

  let {
    theme = "workspace",
    children,
  }: {
    theme?: RhythmPreviewTheme;
    children: Snippet;
  } = $props();
  let host = $state<HTMLDivElement>();
  setContext("rhythm-theme-host", () => host);
</script>

<div bind:this={host} class="rhythm-scope" data-rhythm-theme={theme}>
  {@render children()}
</div>
