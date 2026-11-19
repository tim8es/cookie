<script lang="ts">
  import type { Snippet } from "svelte";
  import type { RhythmPreviewTheme } from "./contracts.js";
  import "./rhythm.css";

  let {
    theme = "workspace",
    children,
  }: {
    theme?: RhythmPreviewTheme;
    children: Snippet;
  } = $props();
</script>

<div class="rhythm-scope" data-rhythm-theme={theme}>
  {@render children()}
</div>
