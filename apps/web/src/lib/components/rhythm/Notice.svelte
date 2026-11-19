<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    description,
    tone = "info",
    action,
  }: {
    title: string;
    description?: string;
    tone?: "info" | "error" | "success" | "loading";
    action?: Snippet;
  } = $props();
</script>

<div class="rhythm-notice" data-tone={tone} data-component="Notice">
  <div role={tone === "error" ? "alert" : "status"} class="rhythm-copy">
    <strong>{title}</strong>
    {#if description}<small>{description}</small>{/if}
  </div>
  {#if action}{@render action()}{/if}
</div>
